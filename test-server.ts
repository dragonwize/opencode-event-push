#!/usr/bin/env bun
/**
 * test-server.ts
 *
 * A simple Bun HTTP server for testing opencode-event-push.
 * Listens for POST requests and pretty-prints each event to the terminal.
 *
 * Usage:
 *   bun run test-server.ts [port]
 *
 * Default port: 34567
 */

const PORT = Number(process.argv[2] ?? 34567)

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const c = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  cyan:    "\x1b[36m",
  yellow:  "\x1b[33m",
  green:   "\x1b[32m",
  red:     "\x1b[31m",
  magenta: "\x1b[35m",
  gray:    "\x1b[90m",
}

function colorForEventType(type: string): string {
  if (type.startsWith("session."))    return c.cyan
  if (type.startsWith("tool."))       return c.yellow
  if (type.startsWith("message."))    return c.magenta
  if (type.startsWith("file."))       return c.green
  if (type.startsWith("permission.")) return c.red
  return c.reset
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "")
}

let eventCount = 0

function printEvent(body: unknown): void {
  eventCount++

  const event = body as Record<string, unknown>
  const type = typeof event.type === "string" ? event.type : "unknown"
  const color = colorForEventType(type)

  const divider = c.dim + "─".repeat(60) + c.reset
  console.log(divider)
  console.log(
    `${c.dim}[${timestamp()}]${c.reset}  ` +
    `${c.bold}#${eventCount}${c.reset}  ` +
    `${color}${c.bold}${type}${c.reset}`,
  )

  // Full pretty-printed JSON below
  console.log(c.dim + JSON.stringify(body, null, 2).split("\n").map(l => "  " + l).join("\n") + c.reset)
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    // Only accept POST
    if (req.method !== "POST") {
      return new Response("Method Not Allowed — send POST requests here.\n", { status: 405 })
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return new Response("Bad Request — body must be valid JSON.\n", { status: 400 })
    }

    printEvent(body)
    return new Response("OK\n", { status: 200 })
  },
})

console.log(`${c.bold}${c.green}opencode-event-push test server${c.reset}`)
console.log(`${c.dim}Listening on${c.reset} ${c.cyan}http://localhost:${server.port}${c.reset}`)
console.log(`${c.dim}Waiting for events…${c.reset}\n`)
console.log(`Point a target at this URL in your event-push.json:`)
console.log(`  ${c.yellow}"url": "http://localhost:${server.port}"${c.reset}\n`)
