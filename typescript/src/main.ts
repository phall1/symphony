import { Effect, Layer } from "effect"
import { makeWorkflowStoreLive } from "./config/index.js"
import { LinearTrackerClientLive } from "./tracker/index.js"
import { WorkspaceManagerLive } from "./workspace/index.js"
import { PromptEngineLive } from "./prompt/index.js"
import { makeCodexAgentEngineLive } from "./engine/codex/index.js"
import { makeOpenCodeAgentEngineLive } from "./engine/opencode/index.js"
import { OrchestratorLive } from "./orchestrator/index.js"
import { makeObservabilityLive } from "./observability/index.js"
import { WorkflowStore } from "./services.js"

export function main(workflowPath: string, port: number = 0): Effect.Effect<void> {
  const workflowStoreLayer = makeWorkflowStoreLive(workflowPath)

  const trackerLayer = LinearTrackerClientLive.pipe(Layer.provide(workflowStoreLayer))

  const workspaceLayer = WorkspaceManagerLive.pipe(Layer.provide(workflowStoreLayer))

  const agentEngineLayer = Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const config = yield* store.getResolved()
      if (config.agent.engine === "opencode") {
        return makeOpenCodeAgentEngineLive()
      }
      return makeCodexAgentEngineLive()
    })
  ).pipe(Layer.provide(workflowStoreLayer))

  // Leaf deps that don't depend on each other
  const depsLayer = Layer.mergeAll(
    workflowStoreLayer,
    trackerLayer,
    workspaceLayer,
    PromptEngineLive,
    agentEngineLayer,
  )

  // OrchestratorLive requires all leaf deps; wire them explicitly
  const orchestratorLayer = OrchestratorLive.pipe(Layer.provide(depsLayer))

  // Observability requires OrchestratorStateRef (provided by orchestratorLayer)
  const observabilityLayer = Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const config = yield* store.getResolved()
      const effectivePort = port > 0 ? port : (config.server?.port ?? 0)
      return makeObservabilityLive(effectivePort).pipe(Layer.provide(orchestratorLayer))
    })
  ).pipe(Layer.provide(workflowStoreLayer))

  const MainLayer = Layer.mergeAll(
    depsLayer,
    orchestratorLayer,
    observabilityLayer,
  )

  return Effect.gen(function* () {
    const store = yield* WorkflowStore
    yield* Effect.orDie(store.getResolved())
    yield* Effect.never
  }).pipe(Effect.provide(MainLayer), Effect.asVoid) as Effect.Effect<void>
}
