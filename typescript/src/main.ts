import { Effect, Layer } from "effect"
import { makeWorkflowStoreLive } from "./config/index.js"
import { makeLinearTrackerClientLive } from "./tracker/index.js"
import { makeWorkspaceManagerLive } from "./workspace/index.js"
import { PromptEngineLive } from "./prompt/index.js"
import { makeCodexAgentEngineLive } from "./engine/codex/index.js"
import { OrchestratorLive } from "./orchestrator/index.js"
import { makeObservabilityLive } from "./observability/index.js"
import { WorkflowStore } from "./services.js"

export function main(workflowPath: string, port: number = 0): Effect.Effect<void> {
  const workflowStoreLayer = makeWorkflowStoreLive(workflowPath)

  const trackerLayer = Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const config = yield* store.getResolved()
      return makeLinearTrackerClientLive(config)
    })
  ).pipe(Layer.provide(workflowStoreLayer))

  const workspaceLayer = Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const config = yield* store.getResolved()
      return makeWorkspaceManagerLive(config)
    })
  ).pipe(Layer.provide(workflowStoreLayer))

  // Leaf deps that don't depend on each other
  const depsLayer = Layer.mergeAll(
    workflowStoreLayer,
    trackerLayer,
    workspaceLayer,
    PromptEngineLive,
    makeCodexAgentEngineLive(),
  )

  // OrchestratorLive requires all leaf deps; wire them explicitly
  const orchestratorLayer = OrchestratorLive.pipe(Layer.provide(depsLayer))

  // Observability requires OrchestratorStateRef (provided by orchestratorLayer)
  const observabilityLayer = makeObservabilityLive(port).pipe(
    Layer.provide(orchestratorLayer)
  )

  const MainLayer = Layer.mergeAll(
    depsLayer,
    orchestratorLayer,
    observabilityLayer,
  )

  return Effect.gen(function* () {
    const store = yield* WorkflowStore
    yield* store.getResolved()
    yield* Effect.never
    // as any: Effect.never makes the return type `never`, but the function signature
    // expects Effect<void>. The program runs forever via Effect.never; this is intentional.
  }).pipe(Effect.provide(MainLayer)) as Effect.Effect<void>
}
