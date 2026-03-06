import { describe, it, expect } from "vitest"
import { Effect, Layer, Stream } from "effect"
import { AgentEngine } from "./agent.js"
import type { AgentEngineError, AgentSession, AgentSessionError } from "./agent.js"
import type { AgentEvent, ResolvedConfig } from "../types.js"

const mockSession: AgentSession = {
  sessionId: "sess-test-001",
  threadId: "thread-test-001",
  runTurn: (_input): Stream.Stream<AgentEvent, AgentSessionError> => {
    const events: AgentEvent[] = [
      { type: "session_started", sessionId: "sess-test-001" },
      { type: "turn_completed" },
    ]
    return Stream.fromIterable(events)
  },
  abort: () => Effect.void,
  dispose: () => Effect.void,
}

const MockAgentEngineLive = Layer.succeed(AgentEngine, {
  createSession: (_input) => Effect.succeed(mockSession),
})

const run = <A>(effect: Effect.Effect<A, unknown, AgentEngine>) =>
  Effect.runPromise(Effect.provide(effect, MockAgentEngineLive))

describe("AgentEngine contract", () => {
  it("mock engine creates a session successfully", async () => {
    const sessionId = await run(
      Effect.gen(function* () {
        const engine = yield* AgentEngine
        const session = yield* engine.createSession({
          workspace: "/tmp/ws",
          cwd: "/tmp/ws",
          config: {} as ResolvedConfig,
        })
        return session.sessionId
      }),
    )
    expect(sessionId).toBe("sess-test-001")
  })

  it("mock session runTurn emits session_started then turn_completed", async () => {
    const events = await run(
      Effect.gen(function* () {
        const engine = yield* AgentEngine
        const session = yield* engine.createSession({
          workspace: "/tmp/ws",
          cwd: "/tmp/ws",
          config: {} as ResolvedConfig,
        })
        return yield* Stream.runCollect(
          session.runTurn({ prompt: "fix the bug", title: "T-1: Fix", continuation: false }),
        )
      }),
    )
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: "session_started", sessionId: "sess-test-001" })
    expect(events[1]).toMatchObject({ type: "turn_completed" })
  })

  it("mock session abort() resolves without error", async () => {
    await run(
      Effect.gen(function* () {
        const engine = yield* AgentEngine
        const session = yield* engine.createSession({
          workspace: "/tmp/ws",
          cwd: "/tmp/ws",
          config: {} as ResolvedConfig,
        })
        yield* session.abort()
      }),
    )
  })

  it("mock session dispose() resolves without error", async () => {
    await run(
      Effect.gen(function* () {
        const engine = yield* AgentEngine
        const session = yield* engine.createSession({
          workspace: "/tmp/ws",
          cwd: "/tmp/ws",
          config: {} as ResolvedConfig,
        })
        yield* session.dispose()
      }),
    )
  })

  it("AgentEngineError has _tag: AgentEngineError", () => {
    const error: AgentEngineError = {
      _tag: "AgentEngineError",
      message: "subprocess failed to start",
    }
    expect(error._tag).toBe("AgentEngineError")
  })

  it("AgentSessionError has _tag: AgentSessionError", () => {
    const error: AgentSessionError = {
      _tag: "AgentSessionError",
      message: "turn timed out",
    }
    expect(error._tag).toBe("AgentSessionError")
  })
})
