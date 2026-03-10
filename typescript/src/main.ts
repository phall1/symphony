import { Effect, Layer } from "effect"
import { makeWorkflowStoreLive } from "./config/index.js"
import { LinearTrackerClientLive } from "./tracker/index.js"
import { WorkspaceManagerLive } from "./workspace/index.js"
import { PromptEngineLive } from "./prompt/index.js"
import { AgentEngineLive } from "./engine/index.js"
import { OrchestratorLive } from "./orchestrator/index.js"
import { ObservabilityLive, makeObservabilityLive } from "./observability/index.js"

export function main(workflowPath: string, port: number = 0): Effect.Effect<void> {
  const workflowStoreLayer = makeWorkflowStoreLive(workflowPath)

  const trackerLayer = LinearTrackerClientLive.pipe(Layer.provide(workflowStoreLayer))

  const workspaceLayer = WorkspaceManagerLive.pipe(Layer.provide(workflowStoreLayer))

  const agentEngineLayer = AgentEngineLive.pipe(Layer.provide(workflowStoreLayer))

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

  const observabilityLayer =
    (port > 0
      ? makeObservabilityLive(port)
      : ObservabilityLive
    ).pipe(Layer.provide(Layer.merge(workflowStoreLayer, orchestratorLayer)))

  const MainLayer = Layer.mergeAll(
    depsLayer,
    orchestratorLayer,
    observabilityLayer,
  )

  return Effect.never.pipe(Effect.provide(MainLayer), Effect.asVoid)
}
