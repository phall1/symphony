import { Effect, Layer, Ref } from "effect"
import { makeInitialState } from "./state.js"
import { pollLoop, startupTerminalCleanup } from "./poll.js"
import { type OrchestratorDeps } from "./dispatch.js"
import {
  WorkflowStore,
  OrchestratorStateRef,
} from "../services.js"
import { validateDispatchConfig } from "../config/index.js"

export { makeInitialState } from "./state.js"
export { sortForDispatch, isEligible } from "./dispatch.js"
export { startupTerminalCleanup, handleWorkerExit } from "./poll.js"

export const OrchestratorLive: Layer.Layer<
  OrchestratorStateRef,
  never,
  OrchestratorDeps
> = Layer.effect(OrchestratorStateRef)(
  Effect.gen(function* () {
    const store = yield* WorkflowStore
    const config = yield* Effect.orDie(store.getResolved())

    const errors = validateDispatchConfig(config)
    if (errors.length > 0) {
      yield* Effect.die(
        new Error(
          `Invalid dispatch config: ${errors.map((e) => e.message).join("; ")}`
        )
      )
    }

    yield* startupTerminalCleanup(config)

    const initialState = makeInitialState(
      config.polling.interval_ms,
      config.agent.max_concurrent_agents
    )
    const stateRef = yield* Ref.make(initialState)
    const obsRef = yield* Ref.make(initialState)

    yield* Effect.forkChild(pollLoop(stateRef, config.polling.interval_ms))

    yield* Effect.addFinalizer(() =>
      Effect.logInfo("Orchestrator shutting down")
    )

    return { ref: obsRef }
  })
)
