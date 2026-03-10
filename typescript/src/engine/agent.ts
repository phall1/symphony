import type { Effect, Stream } from "effect"
import { Data, ServiceMap } from "effect"
import type {
  AgentEvent,
  AgentError,
  ResolvedConfig,
} from "../types.js"

// ─── AgentEngineError ─────────────────────────────────────────────────────────

/**
 * Signals that session creation failed before any turn began.
 *
 * Raised by: subprocess failed to start, handshake protocol error,
 * `thread/start` response timeout, or any fatal startup condition.
 *
 * Callers should treat this as a retriable error — the workspace is still
 * valid but the agent process needs to be restarted.
 */
export class AgentEngineError extends Data.TaggedError("AgentEngineError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

// ─── AgentSessionError ────────────────────────────────────────────────────────

/**
 * Signals that a running turn's event stream terminated with an error.
 *
 * Raised by: `turn_timeout_ms` exceeded, subprocess exited unexpectedly,
 * JSON protocol parse failure, or any fatal mid-turn condition.
 *
 * A session that raises `AgentSessionError` should be considered dead —
 * call `dispose()` and do not attempt further turns on the same session.
 */
export class AgentSessionError extends Data.TaggedError("AgentSessionError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

// ─── AgentSession ─────────────────────────────────────────────────────────────

/**
 * A live coding-agent session bound to a workspace and subprocess.
 *
 * ## runTurn contract
 *
 * The returned stream MUST emit, in order:
 *   1. `{ type: "session_started" }` — first event, confirms subprocess is live
 *   2. Zero or more intermediate events (notification, approval_auto_approved, etc.)
 *   3. Exactly one terminal event: `turn_completed` | `turn_failed` | `turn_cancelled`
 *
 * The stream MUST NOT emit events after the terminal event.
 *
 * ## abort() contract
 *
 * Terminates the underlying subprocess immediately (SIGTERM/SIGKILL).
 * After `abort()` resolves:
 *   - The subprocess is no longer running
 *   - No further events will be emitted on any open stream from this session
 *   - Idempotent: safe to call more than once
 *
 * ## dispose() contract
 *
 * Releases all resources owned by this session (subprocess, I/O handles,
 * queues, fibers, open Scopes). After `dispose()` resolves:
 *   - All managed resources are freed
 *   - The session object MUST NOT be used again
 *   - Idempotent: implementations SHOULD tolerate multiple calls
 *
 * ## Continuation turn semantics
 *
 * When `continuation: true`, the turn is sent on the same live `threadId`
 * (no new subprocess is spawned). The `prompt` field carries only the
 * continuation guidance for this turn — NOT the original full prompt.
 *
 * The `sessionId` field is stable across all turns in one worker run.
 * The `threadId` field MUST remain the same for continuation turns.
 */
export interface AgentSession {
  readonly sessionId: string
  readonly threadId: string
  runTurn(input: {
    readonly prompt: string
    readonly title: string
    readonly continuation: boolean
  }): Stream.Stream<AgentEvent, AgentSessionError>
  abort(): Effect.Effect<void>
  dispose(): Effect.Effect<void>
}

// ─── AgentEngine Service ──────────────────────────────────────────────────────

/**
 * AgentEngine service — abstract interface for coding agent backends.
 *
 * ## Implementations
 * - `CodexAgentEngineLive`: Codex app-server via subprocess JSON-RPC
 * - `OpenCodeAgentEngineLive`: OpenCode server (HTTP/WebSocket)
 *
 * ## createSession contract
 *
 * Returns an `AgentSession` ready to accept `runTurn` calls.
 * The implementation MUST complete the session startup handshake
 * (e.g. `initialize → initialized → thread/start`) before returning.
 *
 * On failure, raises `AgentEngineError`. The caller retains responsibility
 * for retrying or failing the worker run.
 *
 * ## Selection
 *
 * The active backend is selected via `agent.engine` in `WorkflowConfig`
 * (`"codex"` | `"opencode"`). The appropriate `AgentEngine` layer is
 * provided at program startup based on the resolved config.
 *
 * Uses `ServiceMap.Service` (Effect v4) for dependency injection.
 */
export class AgentEngine extends ServiceMap.Service<
  AgentEngine,
  {
    createSession(input: {
      readonly workspace: string
      readonly cwd: string
      readonly config: ResolvedConfig
    }): Effect.Effect<AgentSession, AgentEngineError>
  }
>()(
  "AgentEngine"
) {}
