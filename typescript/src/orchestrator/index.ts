import { Effect, Layer, Ref } from "effect"
import { makeInitialState } from "./state.js"
import { pollLoop, startupTerminalCleanup } from "./poll.js"
import {
  WorkflowStore,
  OrchestratorStateRef,
} from "../services.js"
import { validateDispatchConfig } from "../config/index.js"

export { makeInitialState } from "./state.js"
export { sortForDispatch, isEligible } from "./dispatch.js"
export { startupTerminalCleanup, handleWorkerExit } from "./poll.js"

export const OrchestratorLive = Layer.effect(OrchestratorStateRef)(
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
    const orchestratorStateRef = { ref: stateRef }

    // Provide OrchestratorStateRef to the poll loop INTERNALLY
    // so tick() can access it without creating a circular external dependency
    yield* Effect.forkChild(
      pollLoop(stateRef, config.polling.interval_ms).pipe(
        Effect.provideService(OrchestratorStateRef, orchestratorStateRef)
      )
    )

    yield* Effect.addFinalizer(() =>
      Effect.logInfo("Orchestrator shutting down")
    )

    return orchestratorStateRef
  })
)
