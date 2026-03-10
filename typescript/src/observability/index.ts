import { Effect, Layer } from "effect"
import { OrchestratorStateRef, WorkflowStore } from "../services.js"
import { LoggerLive } from "./logger.js"
import { startHttpServer } from "./http.js"

export { LoggerLive, withIssueContext, withSessionContext } from "./logger.js"
export { buildSnapshot } from "./snapshot.js"
export { startHttpServer } from "./http.js"

// ─── ObservabilityLive ────────────────────────────────────────────────────────

export function makeObservabilityLive(port: number): Layer.Layer<never, never, OrchestratorStateRef> {
  const httpLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const { ref, pollTrigger } = yield* OrchestratorStateRef
      yield* startHttpServer(port, ref, pollTrigger)
    })
  )

  return Layer.merge(LoggerLive, httpLayer)
}

export const ObservabilityLive: Layer.Layer<never, never, WorkflowStore | OrchestratorStateRef> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const config = yield* Effect.orDie(store.getResolved())
      const { ref, pollTrigger } = yield* OrchestratorStateRef
      const port = config.server.port ?? 0
      yield* startHttpServer(port, ref, pollTrigger, config.server.host)
    })
  ).pipe(Layer.provide(LoggerLive))
