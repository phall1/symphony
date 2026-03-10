import type { Effect } from "effect"
import type { AgentEngineError } from "../agent.js"

export interface CodexProtocol {
  readonly sendRequest: (
    method: string,
    params: unknown,
  ) => Effect.Effect<Record<string, unknown>, AgentEngineError>
  readonly sendNotification: (
    method: string,
    params: unknown,
  ) => Effect.Effect<void>
  readonly sendResponse: (
    id: unknown,
    result: unknown,
  ) => Effect.Effect<void>
}
