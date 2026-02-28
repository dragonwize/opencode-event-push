import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Plugin } from "@opencode-ai/plugin"

// ── Config types ──────────────────────────────────────────────────────────────

interface RetryConfig {
  /** Maximum number of attempts (including the first). Default: 3 */
  attempts?: number
  /** Base delay in milliseconds for exponential backoff. Default: 500 */
  delayMs?: number
}

interface TargetConfig {
  /** Required. URL to POST events to. */
  url: string
  /**
   * Optional allowlist of event types to forward to this target.
   * Omit (or set to an empty array) to forward all events.
   */
  events?: string[]
  /** Optional retry policy. */
  retry?: RetryConfig
  /** Optional extra HTTP headers (e.g. Authorization, X-API-Key). */
  headers?: Record<string, string>
}

interface PluginConfig {
  targets: TargetConfig[]
}

// ── Variable substitution ─────────────────────────────────────────────────────

/**
 * Recursively walk any JSON-parsed value and replace all occurrences of
 * `{env:VAR_NAME}` in string leaves with the value of `process.env.VAR_NAME`.
 * Unset variables are replaced with an empty string, matching OpenCode's own
 * behaviour for `{env:...}` in opencode.json.
 */
export function interpolate<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
      return process.env[name] ?? ""
    }) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map(interpolate) as unknown as T
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = interpolate(v)
    }
    return result as unknown as T
  }
  return value
}

// ── Config loading ────────────────────────────────────────────────────────────

/**
 * Read and parse a single opencode-event-push.json file.
 * Returns `null` when the file does not exist.
 * Returns `{ targets: [] }` on any other error or malformed content.
 */
export function readConfigFile(filePath: string): PluginConfig | null {
  try {
    const raw = readFileSync(filePath, "utf-8")
    const parsed = interpolate(JSON.parse(raw) as PluginConfig)
    if (!Array.isArray(parsed.targets)) {
      console.warn(
        `[opencode-event-push] ${filePath} is missing a 'targets' array — skipping`,
      )
      return { targets: [] }
    }
    return parsed
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT"
    if (!isNotFound) {
      console.warn(
        `[opencode-event-push] Could not read ${filePath}: ${String(err)}`,
      )
    }
    return null
  }
}

/**
 * Load and merge plugin configuration from all supported locations.
 *
 * Config is read from two places (mirroring OpenCode's own precedence model):
 *   1. Global:  ~/.config/opencode/opencode-event-push.json
 *   2. Project: <directory>/opencode-event-push.json  (the session's working directory)
 *
 * Both files are optional. When both exist their `targets` arrays are
 * concatenated — project targets are appended after global targets.
 * This follows OpenCode's "merge, not replace" convention for config files.
 *
 * Both files support `{env:VAR_NAME}` substitution in any string value.
 */
export function loadConfig(directory?: string): PluginConfig {
  const globalPath = join(homedir(), ".config", "opencode", "opencode-event-push.json")
  const globalConfig = readConfigFile(globalPath)

  const projectPath = directory ? join(directory, "opencode-event-push.json") : null
  const projectConfig = projectPath ? readConfigFile(projectPath) : null

  const targets = [
    ...(globalConfig?.targets ?? []),
    ...(projectConfig?.targets ?? []),
  ]

  return { targets }
}

// ── HTTP push with retry ──────────────────────────────────────────────────────

export async function pushToTarget(
  target: TargetConfig,
  payload: unknown,
  log: (msg: string, extra?: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const { url, retry = {}, headers = {} } = target
  const maxAttempts = retry.attempts ?? 3
  const baseDelay = retry.delayMs ?? 500

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
      })

      if (res.ok) return

      throw new Error(`HTTP ${res.status} ${res.statusText}`)
    } catch (err) {
      const isLastAttempt = attempt === maxAttempts - 1
      if (isLastAttempt) {
        await log(
          `Failed to push event to ${url} after ${maxAttempts} attempt(s): ${String(err)}`,
          { url, error: String(err), attempts: maxAttempts },
        )
        return
      }

      // Exponential backoff: 500ms, 1000ms, 2000ms, …
      const delay = baseDelay * 2 ** attempt
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const EventPushPlugin: Plugin = async ({ client, directory }) => {
  const { targets } = loadConfig(directory)

  if (targets.length === 0) return {}

  async function log(message: string, extra?: Record<string, unknown>) {
    await client.app.log({
      body: {
        service: "opencode-event-push",
        level: "warn",
        message,
        extra,
      },
    })
  }

  return {
    event: async ({ event }) => {
      const matchingTargets = targets.filter(
        (t) =>
          !t.events || t.events.length === 0 || t.events.includes(event.type),
      )

      if (matchingTargets.length === 0) return

      await Promise.allSettled(
        matchingTargets.map((target) => pushToTarget(target, event, log)),
      )
    },
  }
}

export default EventPushPlugin
