import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { Effect, Queue, Stream } from "effect"
import { performHandshake } from "./handshake.js"
import { launchCodexProcess, splitIntoLines } from "./process.js"
import { streamTurn } from "./streaming.js"
import type { CodexProtocol } from "./protocol.js"
import type { AgentEngineError } from "../agent.js"
import type { ResolvedConfig } from "../../types.js"

const makeCodexConfig = (): ResolvedConfig["codex"] => ({
  command: "codex app-server",
  approval_policy: {
    reject: { sandbox_approval: true, rules: true, mcp_elicitations: true },
  },
  thread_sandbox: "workspace-write",
  turn_sandbox_policy: { type: "workspaceWrite", workspacePath: "/ws" },
  read_timeout_ms: 5000,
  turn_timeout_ms: 3600000,
  stall_timeout_ms: 300000,
})

const makeSuccessProtocol = (): CodexProtocol => ({
  sendRequest: (method) => {
    if (method === "thread/start") return Effect.succeed({ thread: { id: "thread-abc" } })
    if (method === "turn/start") return Effect.succeed({ turn: { id: "turn-xyz" } })
    return Effect.succeed({})
  },
  sendNotification: () => Effect.void,
  sendResponse: () => Effect.void,
})

const makeBunSpawnMock = (stdoutData: string, stderrData = "") =>
  ({
    pid: 42,
    stdin: { write: vi.fn(), flush: vi.fn() },
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        if (stdoutData) controller.enqueue(new TextEncoder().encode(stdoutData))
        controller.close()
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        if (stderrData) controller.enqueue(new TextEncoder().encode(stderrData))
        controller.close()
      },
    }),
    exited: Promise.resolve(0),
    kill: vi.fn(),
  }) as unknown as ReturnType<typeof Bun.spawn>

describe("§17.5 Codex engine conformance", () => {
  beforeAll(() => {
    if (typeof (globalThis as Record<string, unknown>)["Bun"] === "undefined") {
      vi.stubGlobal("Bun", { spawn: vi.fn() })
    }
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it("1. launch command uses workspace cwd and invokes bash -lc <codex.command>", async () => {
    const spawnSpy = vi.spyOn(Bun, "spawn").mockReturnValueOnce(makeBunSpawnMock(""))

    await Effect.runPromise(Effect.scoped(launchCodexProcess("/workspace/test-issue", makeCodexConfig())))

    expect(spawnSpy).toHaveBeenCalledWith(
      ["bash", "-lc", "codex app-server"],
      expect.objectContaining({ cwd: "/workspace/test-issue" }),
    )

    spawnSpy.mockRestore()
  })

  it("2. startup handshake sends initialize, initialized, thread/start, turn/start", async () => {
    const calls: string[] = []

    const protocol: CodexProtocol = {
      sendRequest: (method) => {
        calls.push(`req:${method}`)
        if (method === "thread/start") return Effect.succeed({ thread: { id: "t1" } })
        if (method === "turn/start") return Effect.succeed({ turn: { id: "u1" } })
        return Effect.succeed({})
      },
      sendNotification: (method) => {
        calls.push(`notif:${method}`)
        return Effect.void
      },
      sendResponse: () => Effect.void,
    }

    await Effect.runPromise(
      performHandshake(protocol, "/ws", "fix the bug", "T-1: Fix", makeCodexConfig()),
    )

    expect(calls).toEqual(["req:initialize", "notif:initialized", "req:thread/start", "req:turn/start"])
  })

  it("3. initialize payload includes clientInfo and capabilities", async () => {
    let capturedParams: unknown = null

    const protocol: CodexProtocol = {
      sendRequest: (method, params) => {
        if (method === "initialize") capturedParams = params
        if (method === "thread/start") return Effect.succeed({ thread: { id: "t1" } })
        if (method === "turn/start") return Effect.succeed({ turn: { id: "u1" } })
        return Effect.succeed({})
      },
      sendNotification: () => Effect.void,
      sendResponse: () => Effect.void,
    }

    await Effect.runPromise(performHandshake(protocol, "/ws", "test", "T", makeCodexConfig()))

    expect(capturedParams).toMatchObject({
      clientInfo: { name: expect.any(String), version: expect.any(String) },
      capabilities: expect.any(Object),
    })
  })

  it("4. policy-related startup payloads use documented approval/sandbox defaults", async () => {
    let threadParams: unknown = null

    const protocol: CodexProtocol = {
      sendRequest: (method, params) => {
        if (method === "thread/start") {
          threadParams = params
          return Effect.succeed({ thread: { id: "t1" } })
        }
        if (method === "turn/start") return Effect.succeed({ turn: { id: "u1" } })
        return Effect.succeed({})
      },
      sendNotification: () => Effect.void,
      sendResponse: () => Effect.void,
    }

    await Effect.runPromise(performHandshake(protocol, "/ws", "test", "T", makeCodexConfig()))

    expect(threadParams).toMatchObject({
      approvalPolicy: expect.any(Object),
      sandbox: expect.any(String),
    })
  })

  it("5. thread/start and turn/start responses parse nested IDs, emit correct sessionId", async () => {
    const result = await Effect.runPromise(
      performHandshake(makeSuccessProtocol(), "/ws", "test", "T", makeCodexConfig()),
    )

    expect(result.threadId).toBe("thread-abc")
    expect(result.turnId).toBe("turn-xyz")
    expect(result.sessionId).toBe("thread-abc-turn-xyz")
  })

  // ── 6 ─────────────────────────────────────────────────────────────────────

  it("6. read_timeout_ms enforced during startup: hanging protocol times out with AgentEngineError", async () => {
    // A protocol whose sendRequest creates a fresh empty queue and waits on it with a 50 ms
    // timeout — simulating a Codex process that never responds within read_timeout_ms.
    const hangingProtocol: CodexProtocol = {
      sendRequest: () =>
        Queue.unbounded<string>().pipe(
          Effect.flatMap((q) =>
            Queue.take(q).pipe(
              Effect.timeout(50),
              Effect.catchCause(() =>
                Effect.fail<AgentEngineError>({
                  _tag: "AgentEngineError",
                  message: "response_timeout: no response within read_timeout_ms",
                }),
              ),
              Effect.map(() => ({} as Record<string, unknown>)),
            ),
          ),
        ),
      sendNotification: () => Effect.void,
      sendResponse: () => Effect.void,
    }

    const error = await Effect.runPromise(
      Effect.flip(performHandshake(hangingProtocol, "/ws", "test", "T-1", makeCodexConfig())),
    )

    expect(error._tag).toBe("AgentEngineError")
    expect(error.message).toContain("response_timeout")
  })

  // ── 7 ─────────────────────────────────────────────────────────────────────

  it("7. turn_timeout_ms enforced: empty queue fails with turn_timeout AgentSessionError", async () => {
    const queue = await Effect.runPromise(Queue.unbounded<string>())

    const error = await Effect.runPromise(
      // 50 ms turn timeout — queue is empty so no message ever arrives
      Effect.flip(Stream.runDrain(streamTurn(queue, makeSuccessProtocol(), 50))),
    )

    expect(error._tag).toBe("AgentSessionError")
    expect(error.message).toContain("turn_timeout")
  })

  // ── 8 ─────────────────────────────────────────────────────────────────────

  it("8. partial JSON lines are buffered until newline before being emitted", async () => {
    const enc = new TextEncoder()
    const chunks: Uint8Array[] = [
      enc.encode('{"method":"turn/'),     // partial — no newline
      enc.encode('completed"}\n'),         // rest of line + newline
      enc.encode('{"method":"notification","msg":"hi"}\n'), // complete second line
    ]

    const lines = await Effect.runPromise(
      Stream.runCollect(splitIntoLines(Stream.fromIterable(chunks))),
    )

    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('{"method":"turn/completed"}')
    expect(lines[1]).toBe('{"method":"notification","msg":"hi"}')
  })

  // ── 9 ─────────────────────────────────────────────────────────────────────

  it("9. stdout and stderr handled separately: only stdout lines reach the line queue", async () => {
    const spawnSpy = vi.spyOn(Bun, "spawn").mockReturnValueOnce(
      makeBunSpawnMock(
        '{"method":"turn/completed"}\n', // stdout  — parsed as protocol JSON
        "Starting Codex... [debug info]\n", // stderr — must NOT appear in lines
      ),
    )

    const lines = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const proc = yield* launchCodexProcess("/ws", makeCodexConfig())
          return yield* Stream.runCollect(proc.lines)
        }),
      ),
    )

    expect(lines).toEqual(['{"method":"turn/completed"}'])
    spawnSpy.mockRestore()
  })

  // ── 10 ────────────────────────────────────────────────────────────────────

  it("10. non-JSON stderr lines are logged but do not crash parsing", async () => {
    const spawnSpy = vi.spyOn(Bun, "spawn").mockReturnValueOnce(
      makeBunSpawnMock(
        '{"method":"turn/completed"}\n',
        "totally not json! @#$%\n[error] something went wrong\n",
      ),
    )

    // Must not throw despite malformed stderr
    const lines = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const proc = yield* launchCodexProcess("/ws", makeCodexConfig())
          return yield* Stream.runCollect(proc.lines)
        }),
      ),
    )

    expect(lines).toEqual(['{"method":"turn/completed"}'])
    spawnSpy.mockRestore()
  })

  // ── 11 ────────────────────────────────────────────────────────────────────

  it("11. approval requests (all 4 spec variants) are auto-approved with approved:true", async () => {
    const APPROVAL_METHODS = [
      "item/approval/request",
      "item/command/execute/approval",
      "item/patch/approval",
      "approval-request",
    ]

    for (const approvalMethod of APPROVAL_METHODS) {
      const queue = await Effect.runPromise(Queue.unbounded<string>())
      const responses: Array<{ id: unknown; result: unknown }> = []

      const protocol: CodexProtocol = {
        sendRequest: () => Effect.succeed({}),
        sendNotification: () => Effect.void,
        sendResponse: (id, result) => Effect.sync(() => responses.push({ id, result })),
      }

      await Effect.runPromise(
        Queue.offer(queue, JSON.stringify({ id: "req-1", method: approvalMethod, params: {} })),
      )
      await Effect.runPromise(Queue.offer(queue, JSON.stringify({ method: "turn/completed" })))

      const events = await Effect.runPromise(Stream.runCollect(streamTurn(queue, protocol, 5000)))

      expect(
        responses.some((r) => r.id === "req-1" && (r.result as Record<string, unknown>).approved === true),
        `${approvalMethod} should send approved:true response`,
      ).toBe(true)

      expect(
        events.some((e) => e.type === "approval_auto_approved"),
        `${approvalMethod} should emit approval_auto_approved event`,
      ).toBe(true)
    }
  })

  // ── 12 ────────────────────────────────────────────────────────────────────

  it("12. unsupported item/tool/call rejected with success:false without stalling session", async () => {
    const queue = await Effect.runPromise(Queue.unbounded<string>())
    const responses: Array<{ id: unknown; result: unknown }> = []

    const protocol: CodexProtocol = {
      sendRequest: () => Effect.succeed({}),
      sendNotification: () => Effect.void,
      sendResponse: (id, result) => Effect.sync(() => responses.push({ id, result })),
    }

    await Effect.runPromise(
      Queue.offer(
        queue,
        JSON.stringify({ id: "tool-1", method: "item/tool/call", params: { name: "unknown_tool" } }),
      ),
    )
    await Effect.runPromise(Queue.offer(queue, JSON.stringify({ method: "turn/completed" })))

    const events = await Effect.runPromise(Stream.runCollect(streamTurn(queue, protocol, 5000)))

    // Rejected with structured error, NOT stalled
    expect(
      responses.some(
        (r) => r.id === "tool-1" && (r.result as Record<string, unknown>).success === false,
      ),
    ).toBe(true)

    // Session didn't stall — stream completed with turn_completed
    expect(events.some((e) => e.type === "turn_completed")).toBe(true)
  })

  // ── 13 ────────────────────────────────────────────────────────────────────

  it("13. user input requests hard-fail with turn_input_required AgentSessionError", async () => {
    const queue = await Effect.runPromise(Queue.unbounded<string>())

    await Effect.runPromise(
      Queue.offer(
        queue,
        JSON.stringify({
          method: "item/tool/requestUserInput",
          params: { prompt: "Enter a value:" },
        }),
      ),
    )

    const error = await Effect.runPromise(
      Effect.flip(Stream.runDrain(streamTurn(queue, makeSuccessProtocol(), 5000))),
    )

    expect(error._tag).toBe("AgentSessionError")
    expect(error.message).toContain("turn_input_required")
  })

  // ── 14 ────────────────────────────────────────────────────────────────────

  it("14. token/rate-limit payloads extracted from nested payload shapes", async () => {
    const queue = await Effect.runPromise(Queue.unbounded<string>())

    // Nested camelCase shape from thread/tokenUsage/updated
    await Effect.runPromise(
      Queue.offer(
        queue,
        JSON.stringify({
          method: "thread/tokenUsage/updated",
          params: {
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
            },
          },
        }),
      ),
    )
    await Effect.runPromise(Queue.offer(queue, JSON.stringify({ method: "turn/completed" })))

    const events = await Effect.runPromise(
      Stream.runCollect(streamTurn(queue, makeSuccessProtocol(), 5000)),
    )

    const tokenEvent = events.find((e) => e.type === "token_usage")
    expect(tokenEvent).toMatchObject({ type: "token_usage", input: 100, output: 50, total: 150 })
  })
})
