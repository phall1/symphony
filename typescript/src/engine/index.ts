import { Effect, Layer } from "effect"
import { AgentEngine } from "./agent.js"
import { WorkflowStore } from "../services.js"
import { makeCodexAgentEngineLive, makeCodexAgentEngineService } from "./codex/index.js"
import { makeOpenCodeAgentEngineLive, makeOpenCodeAgentEngineService } from "./opencode/index.js"

export { AgentEngine, AgentEngineError, AgentSessionError } from "./agent.js"
export { makeCodexAgentEngineLive } from "./codex/index.js"
export { makeOpenCodeAgentEngineLive } from "./opencode/index.js"

export const AgentEngineLive: Layer.Layer<AgentEngine, never, WorkflowStore> = Layer.effect(
  AgentEngine
)(
  Effect.gen(function* () {
    const store = yield* WorkflowStore
    const config = yield* Effect.orDie(store.getResolved())

    if (config.agent.engine === "opencode") {
      return makeOpenCodeAgentEngineService()
    }

    return makeCodexAgentEngineService()
  })
)
