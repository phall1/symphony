import type { Effect, Stream } from "effect"
import { ServiceMap } from "effect"
import type {
  AgentEvent,
  AgentError,
  ResolvedConfig,
} from "../types.js"

// ─── AgentEngineError ─────────────────────────────────────────────────────────

/**
 * Error thrown when session creation fails
 */
export interface AgentEngineError {
  readonly _tag: "AgentEngineError"
  readonly message: string
  readonly cause?: unknown
}

// ─── AgentSessionError ────────────────────────────────────────────────────────

/**
 * Error thrown during turn streaming
 */
export interface AgentSessionError {
  readonly _tag: "AgentSessionError"
  readonly message: string
  readonly cause?: unknown
}

// ─── AgentSession ─────────────────────────────────────────────────────────────

/**
 * Represents a live coding agent session
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
 * AgentEngine service — abstract interface for coding agent backends
 *
 * Implementations: CodexAgentEngine, OpenCodeAgentEngine
 *
 * Uses ServiceMap.Service (Effect v4) for dependency injection
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
