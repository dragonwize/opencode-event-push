import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
  spyOn,
} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  interpolate,
  readConfigFile,
  loadConfig,
  pushToTarget,
  EventPushPlugin,
} from "./index"

// ── interpolate() ─────────────────────────────────────────────────────────────

describe("interpolate()", () => {
  beforeEach(() => {
    process.env.TEST_VAR = "hello"
    process.env.ANOTHER_VAR = "world"
  })

  afterEach(() => {
    delete process.env.TEST_VAR
    delete process.env.ANOTHER_VAR
  })

  it("replaces a single {env:VAR} token in a string", () => {
    expect(interpolate("{env:TEST_VAR}")).toBe("hello")
  })

  it("replaces multiple {env:...} tokens in one string", () => {
    expect(interpolate("{env:TEST_VAR} {env:ANOTHER_VAR}")).toBe("hello world")
  })

  it("replaces an unset variable with an empty string", () => {
    expect(interpolate("{env:DEFINITELY_NOT_SET_12345}")).toBe("")
  })

  it("leaves a string with no tokens unchanged", () => {
    expect(interpolate("no tokens here")).toBe("no tokens here")
  })

  it("passes numbers through unchanged", () => {
    expect(interpolate(42)).toBe(42)
  })

  it("passes booleans through unchanged", () => {
    expect(interpolate(true)).toBe(true)
    expect(interpolate(false)).toBe(false)
  })

  it("passes null through unchanged", () => {
    expect(interpolate(null)).toBeNull()
  })

  it("interpolates strings inside an array", () => {
    expect(interpolate(["{env:TEST_VAR}", "literal"])).toEqual([
      "hello",
      "literal",
    ])
  })

  it("interpolates strings inside a nested object", () => {
    const input = {
      url: "https://example.com/{env:TEST_VAR}",
      headers: { Authorization: "Bearer {env:ANOTHER_VAR}" },
    }
    expect(interpolate(input)).toEqual({
      url: "https://example.com/hello",
      headers: { Authorization: "Bearer world" },
    })
  })

  it("handles deeply-nested structures (object inside array inside object)", () => {
    const input = {
      targets: [{ url: "{env:TEST_VAR}", events: ["{env:ANOTHER_VAR}"] }],
    }
    expect(interpolate(input)).toEqual({
      targets: [{ url: "hello", events: ["world"] }],
    })
  })

  it("replaces only the token portion, leaving surrounding text intact", () => {
    expect(interpolate("prefix-{env:TEST_VAR}-suffix")).toBe(
      "prefix-hello-suffix",
    )
  })
})

// ── readConfigFile() ──────────────────────────────────────────────────────────

describe("readConfigFile()", () => {
  let readFileSyncSpy: ReturnType<typeof spyOn>
  let consoleWarnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    readFileSyncSpy = spyOn(fs, "readFileSync")
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    readFileSyncSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  it("returns a parsed config when the file is valid", () => {
    const config = { targets: [{ url: "https://example.com/hook" }] }
    readFileSyncSpy.mockReturnValue(JSON.stringify(config))

    expect(readConfigFile("/any/path.json")).toEqual(config)
  })

  it("returns null when the file does not exist (ENOENT)", () => {
    const err = Object.assign(new Error("not found"), { code: "ENOENT" })
    readFileSyncSpy.mockImplementation(() => {
      throw err
    })

    expect(readConfigFile("/missing.json")).toBeNull()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it("returns null and warns on a non-ENOENT read error", () => {
    readFileSyncSpy.mockImplementation(() => {
      throw new Error("permission denied")
    })

    expect(readConfigFile("/bad.json")).toBeNull()
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
  })

  it("returns { targets: [] } and warns when targets is not an array", () => {
    readFileSyncSpy.mockReturnValue(JSON.stringify({ targets: "oops" }))

    expect(readConfigFile("/bad-targets.json")).toEqual({ targets: [] })
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
  })

  it("returns { targets: [] } and warns on malformed JSON", () => {
    readFileSyncSpy.mockReturnValue("not valid json {{{")

    expect(readConfigFile("/malformed.json")).toBeNull()
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
  })

  it("applies {env:...} interpolation to the parsed config", () => {
    process.env.HOOK_URL = "https://hooks.example.com"
    readFileSyncSpy.mockReturnValue(
      JSON.stringify({ targets: [{ url: "{env:HOOK_URL}" }] }),
    )

    expect(readConfigFile("/env.json")).toEqual({
      targets: [{ url: "https://hooks.example.com" }],
    })

    delete process.env.HOOK_URL
  })
})

// ── loadConfig() ──────────────────────────────────────────────────────────────

describe("loadConfig()", () => {
  let readFileSyncSpy: ReturnType<typeof spyOn>
  let homedirSpy: ReturnType<typeof spyOn>

  const globalTarget = { url: "https://global.example.com" }
  const projectTarget = { url: "https://project.example.com" }

  beforeEach(() => {
    homedirSpy = spyOn(os, "homedir").mockReturnValue("/home/testuser")
    readFileSyncSpy = spyOn(fs, "readFileSync")
    spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    readFileSyncSpy.mockRestore()
    homedirSpy.mockRestore()
  })

  function mockFiles(files: Record<string, string | null>) {
    readFileSyncSpy.mockImplementation((filePath: unknown) => {
      const p = filePath as string
      if (p in files) {
        const content = files[p]
        if (content === null) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
        }
        return content
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })
  }

  const globalPath = path.join(
    "/home/testuser",
    ".config",
    "opencode",
    "opencode-event-push.json",
  )

  it("merges global and project targets, global first", () => {
    mockFiles({
      [globalPath]: JSON.stringify({ targets: [globalTarget] }),
      "/proj/opencode-event-push.json": JSON.stringify({ targets: [projectTarget] }),
    })

    expect(loadConfig("/proj")).toEqual({
      targets: [globalTarget, projectTarget],
    })
  })

  it("returns only project targets when global config is absent", () => {
    mockFiles({
      "/proj/opencode-event-push.json": JSON.stringify({ targets: [projectTarget] }),
    })

    expect(loadConfig("/proj")).toEqual({ targets: [projectTarget] })
  })

  it("returns only global targets when project config is absent", () => {
    mockFiles({
      [globalPath]: JSON.stringify({ targets: [globalTarget] }),
    })

    expect(loadConfig("/proj")).toEqual({ targets: [globalTarget] })
  })

  it("returns { targets: [] } when both files are absent", () => {
    mockFiles({})
    expect(loadConfig("/proj")).toEqual({ targets: [] })
  })

  it("returns { targets: [] } when no directory is provided and global is absent", () => {
    mockFiles({})
    expect(loadConfig()).toEqual({ targets: [] })
  })

  it("returns only global targets when no directory is provided", () => {
    mockFiles({
      [globalPath]: JSON.stringify({ targets: [globalTarget] }),
    })

    expect(loadConfig()).toEqual({ targets: [globalTarget] })
  })
})

// ── pushToTarget() ────────────────────────────────────────────────────────────

describe("pushToTarget()", () => {
  let fetchSpy: ReturnType<typeof spyOn>
  const log = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const payload = { type: "session.created", sessionId: "abc" }
  const target = { url: "https://hook.example.com/push" }

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch")
    log.mockClear()
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  function okResponse() {
    return Promise.resolve(new Response(null, { status: 200 }))
  }

  function errResponse(status = 500) {
    return Promise.resolve(
      new Response(null, { status, statusText: "Internal Server Error" }),
    )
  }

  it("POSTs the payload as JSON on the first attempt", async () => {
    fetchSpy.mockReturnValueOnce(okResponse())

    await pushToTarget(target, payload, log)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(target.url)
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" })
    expect(JSON.parse(init.body as string)).toEqual(payload)
  })

  it("includes custom headers in the request", async () => {
    const targetWithHeaders = {
      url: "https://hook.example.com",
      headers: { Authorization: "Bearer token123", "X-API-Key": "key" },
    }
    fetchSpy.mockReturnValueOnce(okResponse())

    await pushToTarget(targetWithHeaders, payload, log)

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({
      Authorization: "Bearer token123",
      "X-API-Key": "key",
    })
  })

  it("does not call log on a successful first attempt", async () => {
    fetchSpy.mockReturnValueOnce(okResponse())

    await pushToTarget(target, payload, log)

    expect(log).not.toHaveBeenCalled()
  })

  it("retries on a network error and succeeds on the second attempt", async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error("network failure"))
      .mockReturnValueOnce(okResponse())

    await pushToTarget({ ...target, retry: { attempts: 3, delayMs: 0 } }, payload, log)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(log).not.toHaveBeenCalled()
  })

  it("retries on a non-OK HTTP status and succeeds on the second attempt", async () => {
    fetchSpy
      .mockReturnValueOnce(errResponse(503))
      .mockReturnValueOnce(okResponse())

    await pushToTarget({ ...target, retry: { attempts: 3, delayMs: 0 } }, payload, log)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(log).not.toHaveBeenCalled()
  })

  it("calls log after exhausting all attempts and does not throw", async () => {
    fetchSpy.mockRejectedValue(new Error("always fails"))

    await expect(
      pushToTarget({ ...target, retry: { attempts: 3, delayMs: 0 } }, payload, log),
    ).resolves.toBeUndefined()

    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(log).toHaveBeenCalledTimes(1)
    const logMsg = (log.mock.calls[0] as unknown[])[0] as string
    expect(logMsg).toContain("after 3 attempt(s)")
  })

  it("respects a custom retry attempts count", async () => {
    fetchSpy.mockRejectedValue(new Error("fail"))

    await pushToTarget(
      { ...target, retry: { attempts: 5, delayMs: 0 } },
      payload,
      log,
    )

    expect(fetchSpy).toHaveBeenCalledTimes(5)
  })

  it("stops immediately with 1 attempt on failure", async () => {
    fetchSpy.mockReturnValueOnce(errResponse(400))

    await pushToTarget(
      { ...target, retry: { attempts: 1, delayMs: 0 } },
      payload,
      log,
    )

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(1)
  })
})

// ── EventPushPlugin ───────────────────────────────────────────────────────────

describe("EventPushPlugin", () => {
  let readFileSyncSpy: ReturnType<typeof spyOn>
  let fetchSpy: ReturnType<typeof spyOn>
  let homedirSpy: ReturnType<typeof spyOn>

  const mockLog = jest.fn().mockResolvedValue(undefined)
  const mockClient = {
    app: {
      log: mockLog,
    },
  }

  const makeInput = (directory = "/proj") =>
    ({
      client: mockClient,
      directory,
    }) as unknown as Parameters<typeof EventPushPlugin>[0]

  function okResponse() {
    return Promise.resolve(new Response(null, { status: 200 }))
  }

  beforeEach(() => {
    homedirSpy = spyOn(os, "homedir").mockReturnValue("/home/testuser")
    readFileSyncSpy = spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })
    fetchSpy = spyOn(globalThis, "fetch").mockReturnValue(okResponse())
    mockLog.mockClear()
    spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    readFileSyncSpy.mockRestore()
    fetchSpy.mockRestore()
    homedirSpy.mockRestore()
  })

  it("returns an empty object when no targets are configured", async () => {
    const hooks = await EventPushPlugin(makeInput())
    expect(hooks).toEqual({})
  })

  it("returns an event hook when at least one target is configured", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("opencode-event-push.json")) {
        return JSON.stringify({ targets: [{ url: "https://example.com" }] })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    const hooks = await EventPushPlugin(makeInput())
    expect(typeof hooks.event).toBe("function")
  })

  it("calls fetch for a catch-all target on any event type", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).includes("/proj/")) {
        return JSON.stringify({ targets: [{ url: "https://example.com/hook" }] })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    const hooks = await EventPushPlugin(makeInput())
    await hooks.event!({ event: { type: "session.created" } as any })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toBe("https://example.com/hook")
  })

  it("only dispatches to targets whose events list includes the event type", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).includes("/proj/")) {
        return JSON.stringify({
          targets: [
            { url: "https://a.example.com", events: ["session.created"] },
            { url: "https://b.example.com", events: ["tool.use"] },
          ],
        })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    const hooks = await EventPushPlugin(makeInput())
    await hooks.event!({ event: { type: "session.created" } as any })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toBe("https://a.example.com")
  })

  it("dispatches to all matching targets in parallel", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).includes("/proj/")) {
        return JSON.stringify({
          targets: [
            { url: "https://a.example.com" },
            { url: "https://b.example.com" },
          ],
        })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    const hooks = await EventPushPlugin(makeInput())
    await hooks.event!({ event: { type: "tool.use" } as any })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const urls = (fetchSpy.mock.calls as [string][]).map(([u]) => u)
    expect(urls).toContain("https://a.example.com")
    expect(urls).toContain("https://b.example.com")
  })

  it("does not dispatch when no targets match the event type", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).includes("/proj/")) {
        return JSON.stringify({
          targets: [{ url: "https://a.example.com", events: ["session.created"] }],
        })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    const hooks = await EventPushPlugin(makeInput())
    await hooks.event!({ event: { type: "tool.use" } as any })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("continues dispatching to other targets even if one fails", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).includes("/proj/")) {
        return JSON.stringify({
          targets: [
            { url: "https://failing.example.com", retry: { attempts: 1, delayMs: 0 } },
            { url: "https://ok.example.com", retry: { attempts: 1, delayMs: 0 } },
          ],
        })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    fetchSpy.mockImplementation((url: unknown) => {
      if ((url as string).includes("failing")) {
        return Promise.resolve(new Response(null, { status: 500, statusText: "Error" }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    })

    const hooks = await EventPushPlugin(makeInput())
    // Should resolve without throwing despite the failing target
    await expect(
      hooks.event!({ event: { type: "session.created" } as any }),
    ).resolves.toBeUndefined()

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("uses client.app.log to warn when a push fails", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).includes("/proj/")) {
        return JSON.stringify({
          targets: [{ url: "https://failing.example.com", retry: { attempts: 1, delayMs: 0 } }],
        })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    fetchSpy.mockReturnValue(
      Promise.resolve(new Response(null, { status: 503, statusText: "Service Unavailable" })),
    )

    const hooks = await EventPushPlugin(makeInput())
    await hooks.event!({ event: { type: "session.created" } as any })

    expect(mockLog).toHaveBeenCalledTimes(1)
    const logCall = mockLog.mock.calls[0][0] as { body: Record<string, unknown> }
    expect(logCall.body.service).toBe("opencode-event-push")
    expect(logCall.body.level).toBe("warn")
  })
})
