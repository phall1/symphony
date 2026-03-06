import { Effect, Layer } from "effect"
import { makeWorkflowStoreLive } from "./config/index.js"
import { makeLinearTrackerClientLive } from "./tracker/index.js"
import { makeWorkspaceManagerLive } from "./workspace/index.js"
import { PromptEngineLive } from "./prompt/index.js"
import { makeCodexAgentEngineLive } from "./engine/codex/index.js"
import { OrchestratorLive } from "./orchestrator/index.js"
import { WorkflowStore } from "./services.js"

export function main(workflowPath: string): Effect.Effect<void> {
  const workflowStoreLayer = makeWorkflowStoreLive(workflowPath)

  const trackerLayer = (Layer.flatMap as any)(workflowStoreLayer, () =>
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const config = yield* store.getResolved()
      return makeLinearTrackerClientLive(config)
    })
  )

  const workspaceLayer = (Layer.flatMap as any)(workflowStoreLayer, () =>
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const config = yield* store.getResolved()
      return makeWorkspaceManagerLive(config)
    })
  )

  const MainLayer = Layer.mergeAll(
    workflowStoreLayer,
    trackerLayer,
    workspaceLayer,
    PromptEngineLive,
    makeCodexAgentEngineLive(),
    OrchestratorLive,
  )

  return (Effect.gen(function* () {
    const store = yield* WorkflowStore
    yield* store.getResolved()
    yield* Effect.never
  }).pipe(Effect.provide(MainLayer))) as any
}
