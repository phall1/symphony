import { Effect, Layer } from "effect"
import { OrchestratorStateRef } from "../services.js"
import { LoggerLive } from "./logger.js"
import { startHttpServer } from "./http.js"

export { LoggerLive, withIssueContext, withSessionContext } from "./logger.js"
export { buildSnapshot } from "./snapshot.js"
export { startHttpServer } from "./http.js"

// ─── ObservabilityLive ────────────────────────────────────────────────────────

export function makeObservabilityLive(port: number): Layer.Layer<never, never, OrchestratorStateRef> {
  const httpLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const { ref } = yield* OrchestratorStateRef
      yield* startHttpServer(port, ref)
    })
  )

  return Layer.merge(LoggerLive, httpLayer)
}
