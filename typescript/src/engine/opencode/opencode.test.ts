import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Stream } from "effect"
import { AgentEngine } from "../agent.js"
import { makeOpenCodeAgentEngineLive } from "./index.js"
import type { ResolvedConfig } from "../../types.js"

const SERVER_URL = "http://localhost:9999"
const SESSION_ID = "sess-opencode-test"
const WORKSPACE = "/tmp/opencode-test-workspace"

const testConfig: ResolvedConfig = {
  tracker: {
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    api_key: "test-key",
    project_slug: "test",
    active_states: [],
    terminal_states: [],
  },
  polling: { interval_ms: 60000 },
  workspace: { root: "/tmp" },
  hooks: {
    after_create: null,
    before_run: null,
    after_run: null,
    before_remove: null,
    timeout_ms: 30000,
  },
  agent: {
    max_concurrent_agents: 1,
    max_turns: 5,
    max_retry_backoff_ms: 60000,
    max_concurrent_agents_by_state: {},
    engine: "opencode",
  },
  codex: {
    command: "codex",
    approval_policy: null,
    thread_sandbox: "",
    turn_sandbox_policy: null,
    turn_timeout_ms: 60000,
    read_timeout_ms: 30000,
    stall_timeout_ms: 30000,
  },
  opencode: {
    mode: "shared",
    server_url: SERVER_URL,
    model: "claude-3-5-sonnet",
    agent: "default",
    port: 0,
  },
  server: { port: null },
}

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

let fetchCalls: FetchCall[] = []
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  fetchCalls = []
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function setupMockFetch(
  handler: (url: string, options?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    const urlStr = url.toString()
    const headers = (options?.headers as Record<string, string>) ?? {}
    let body: unknown = undefined
    if (options?.body && typeof options.body === "string") {
      try {
        body = JSON.parse(options.body)
      } catch {
        body = options.body
      }
    }
    fetchCalls.push({ url: urlStr, method: options?.method ?? "GET", headers, body })
    return handler(urlStr, options)
  }) as unknown as typeof globalThis.fetch
}

function makeJsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response
}

function makeSseResponse(events: object[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function setupRoutedFetch(sseEvents: object[]): void {
  setupMockFetch((url, options) => {
    const method = options?.method ?? "GET"
    if (method === "POST" && url === `${SERVER_URL}/session`)
      return Promise.resolve(makeJsonResponse({ id: SESSION_ID }))
    if (method === "POST" && url === `${SERVER_URL}/session/${SESSION_ID}/message`)
      return Promise.resolve(makeJsonResponse({ queued: true }))
    if (method === "GET" && url === `${SERVER_URL}/event`)
      return Promise.resolve(makeSseResponse(sseEvents))
    if (method === "POST" && url.startsWith(`${SERVER_URL}/permission/`))
      return Promise.resolve({ ok: true, status: 200 } as Response)
    if (method === "POST" && url === `${SERVER_URL}/session/${SESSION_ID}/abort`)
      return Promise.resolve(makeJsonResponse({}))
    return Promise.reject(new Error(`Unexpected fetch: ${method} ${url}`))
  })
}

const run = <A>(eff: Effect.Effect<A, unknown, AgentEngine>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, makeOpenCodeAgentEngineLive()))

const createSession = Effect.gen(function* () {
  const engine = yield* AgentEngine
  return yield* engine.createSession({
    workspace: WORKSPACE,
    cwd: WORKSPACE,
    config: testConfig,
  })
})

describe("OpenCode engine — shared mode", () => {
  it("sends POST to server_url/session on createSession", async () => {
    setupMockFetch((_url, _opts) =>
      Promise.resolve(makeJsonResponse({ id: SESSION_ID })),
    )

    await run(createSession)

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.url).toBe(`${SERVER_URL}/session`)
    expect(fetchCalls[0]!.method).toBe("POST")
  })

  it("session creation POSTs { title: workspace } to /session", async () => {
    setupMockFetch((_url, _opts) =>
      Promise.resolve(makeJsonResponse({ id: SESSION_ID })),
    )

    await run(createSession)

    expect(fetchCalls[0]!.body).toMatchObject({ title: WORKSPACE })
  })

  it("createSession returns sessionId and threadId from server response", async () => {
    setupMockFetch((_url, _opts) =>
      Promise.resolve(makeJsonResponse({ id: SESSION_ID })),
    )

    const session = await run(createSession)

    expect(session.sessionId).toBe(SESSION_ID)
    expect(session.threadId).toBe(SESSION_ID)
  })

  it("sends x-opencode-directory header on all HTTP requests", async () => {
    setupRoutedFetch([
      { type: "session.status", sessionID: SESSION_ID, data: { type: "idle" } },
    ])

    await run(
      Effect.gen(function* () {
        const engine = yield* AgentEngine
        const session = yield* engine.createSession({
          workspace: WORKSPACE,
          cwd: WORKSPACE,
          config: testConfig,
        })
        yield* Stream.runCollect(
          session.runTurn({ prompt: "test", title: "T", continuation: false }),
        )
      }),
    )

    expect(fetchCalls.length).toBeGreaterThan(0)
    for (const call of fetchCalls) {
      expect(call.headers["x-opencode-directory"]).toBe(WORKSPACE)
    }
  })

  it("runTurn sends POST /session/:id/message with parts, model, agent", async () => {
    setupRoutedFetch([
      { type: "session.status", sessionID: SESSION_ID, data: { type: "idle" } },
    ])

    await run(
      Effect.gen(function* () {
        const engine = yield* AgentEngine
        const session = yield* engine.createSession({
          workspace: WORKSPACE,
          cwd: WORKSPACE,
          config: testConfig,
        })
        yield* Stream.runCollect(
          session.runTurn({ prompt: "Implement feature X", title: "T", continuation: false }),
        )
      }),
    )

    const msgCall = fetchCalls.find((c) => c.url.includes("/message"))
    expect(msgCall).toBeDefined()
    expect(msgCall!.method).toBe("POST")
    expect(msgCall!.url).toBe(`${SERVER_URL}/session/${SESSION_ID}/message`)
    expect(msgCall!.body).toMatchObject({
      parts: [{ type: "text", text: "Implement feature X" }],
      agent: "default",
      model: "claude-3-5-sonnet",
    })
  })

  it("SSE session.status { type: 'idle' } emits turn_completed", async () => {
    setupRoutedFetch([
      { type: "session.status", sessionID: SESSION_ID, data: { type: "idle" } },
    ])

    const events = await run(
      Effect.gen(function* () {
        const engine = yield* AgentEngine
        const session = yield* engine.createSession({
          workspace: WORKSPACE,
          cwd: WORKSPACE,
          config: testConfig,
        })
        return yield* Stream.runCollect(
          session.runTurn({ prompt: "do work", title: "T", continuation: false }),
        )
      }),
    )

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: "session_started", sessionId: SESSION_ID })
    expect(events[1]).toMatchObject({ type: "turn_completed" })
  })

  it("SSE session.error emits turn_failed with error message", async () => {
    setupRoutedFetch([
      {
        type: "session.error",
        sessionID: SESSION_ID,
        data: { error: "Something went wrong" },
      },
    ])

    const events = await run(
      Effect.gen(function* () {
        const engine = yield* AgentEngine
        const session = yield* engine.createSession({
          workspace: WORKSPACE,
          cwd: WORKSPACE,
          config: testConfig,
        })
        return yield* Stream.runCollect(
          session.runTurn({ prompt: "do work", title: "T", continuation: false }),
        )
      }),
    )

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: "session_started" })
    expect(events[1]).toMatchObject({ type: "turn_failed", error: "Something went wrong" })
  })

  it("SSE permission.asked emits approval_auto_approved and POSTs to /permission/:id", async () => {
    setupRoutedFetch([
      {
        type: "permission.asked",
        sessionID: SESSION_ID,
        data: { id: "perm-xyz", description: "Allow file write" },
      },
      { type: "session.status", sessionID: SESSION_ID, data: { type: "idle" } },
    ])

    const events = await run(
      Effect.gen(function* () {
        const engine = yield* AgentEngine
        const session = yield* engine.createSession({
          workspace: WORKSPACE,
          cwd: WORKSPACE,
          config: testConfig,
        })
        return yield* Stream.runCollect(
          session.runTurn({ prompt: "do work", title: "T", continuation: false }),
        )
      }),
    )

    const approvalEvent = events.find((e) => e.type === "approval_auto_approved")
    expect(approvalEvent).toBeDefined()
    expect(approvalEvent).toMatchObject({
      type: "approval_auto_approved",
      description: "Allow file write",
    })

    expect(events[events.length - 1]).toMatchObject({ type: "turn_completed" })

    const permCall = fetchCalls.find((c) => c.url.includes("/permission/"))
    expect(permCall).toBeDefined()
    expect(permCall!.url).toBe(`${SERVER_URL}/permission/perm-xyz`)
    expect(permCall!.method).toBe("POST")
  })

  it("SSE server.heartbeat emits stall_heartbeat", async () => {
    setupRoutedFetch([
      { type: "server.heartbeat", sessionID: SESSION_ID },
      { type: "session.status", sessionID: SESSION_ID, data: { type: "idle" } },
    ])

    const events = await run(
      Effect.gen(function* () {
        const engine = yield* AgentEngine
        const session = yield* engine.createSession({
          workspace: WORKSPACE,
          cwd: WORKSPACE,
          config: testConfig,
        })
        return yield* Stream.runCollect(
          session.runTurn({ prompt: "do work", title: "T", continuation: false }),
        )
      }),
    )

    expect(events.some((e) => e.type === "stall_heartbeat")).toBe(true)
    expect(events[events.length - 1]).toMatchObject({ type: "turn_completed" })
  })

  it("SSE message.part.updated emits notification with content", async () => {
    setupRoutedFetch([
      {
        type: "message.part.updated",
        sessionID: SESSION_ID,
        data: { content: "Working on it..." },
      },
      { type: "session.status", sessionID: SESSION_ID, data: { type: "idle" } },
    ])

    const events = await run(
      Effect.gen(function* () {
        const engine = yield* AgentEngine
        const session = yield* engine.createSession({
          workspace: WORKSPACE,
          cwd: WORKSPACE,
          config: testConfig,
        })
        return yield* Stream.runCollect(
          session.runTurn({ prompt: "do work", title: "T", continuation: false }),
        )
      }),
    )

    const notif = events.find((e) => e.type === "notification")
    expect(notif).toBeDefined()
    expect(notif).toMatchObject({ type: "notification", message: "Working on it..." })
    expect(events[events.length - 1]).toMatchObject({ type: "turn_completed" })
  })

  it("abort sends POST /session/:id/abort", async () => {
    setupMockFetch((_url, _opts) =>
      Promise.resolve(makeJsonResponse({ id: SESSION_ID })),
    )

    await run(
      Effect.gen(function* () {
        const engine = yield* AgentEngine
        const session = yield* engine.createSession({
          workspace: WORKSPACE,
          cwd: WORKSPACE,
          config: testConfig,
        })
        yield* session.abort()
      }),
    )

    const abortCall = fetchCalls.find((c) => c.url.includes("/abort"))
    expect(abortCall).toBeDefined()
    expect(abortCall!.url).toBe(`${SERVER_URL}/session/${SESSION_ID}/abort`)
    expect(abortCall!.method).toBe("POST")
  })
})
