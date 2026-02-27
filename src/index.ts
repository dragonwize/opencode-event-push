import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode-ai/plugin"

const __dirname = dirname(fileURLToPath(import.meta.url))

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

// ── Config loading ────────────────────────────────────────────────────────────

function loadConfig(): PluginConfig {
  // The config file lives alongside the plugin (one level up from src/)
  const configPath = join(__dirname, "..", "event-push.json")
  try {
    const raw = readFileSync(configPath, "utf-8")
    const parsed = JSON.parse(raw) as PluginConfig
    if (!Array.isArray(parsed.targets)) {
      console.warn(
        "[opencode-event-push] event-push.json is missing a 'targets' array — plugin is a no-op",
      )
      return { targets: [] }
    }
    return parsed
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT"
    if (!isNotFound) {
      console.warn(
        `[opencode-event-push] Could not read event-push.json: ${String(err)}`,
      )
    }
    return { targets: [] }
  }
}

// ── HTTP push with retry ──────────────────────────────────────────────────────

async function pushToTarget(
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

export const EventPushPlugin: Plugin = async ({ client }) => {
  const { targets } = loadConfig()

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
