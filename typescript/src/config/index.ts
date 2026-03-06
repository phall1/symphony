import { Effect, Layer, Ref } from "effect"
import { loadWorkflowFile } from "./loader.js"
import { resolveConfig } from "./resolve.js"
import { watchWorkflowFile } from "./watcher.js"
import { WorkflowStore } from "../services.js"
import type { WorkflowDefinition, ResolvedConfig } from "../types.js"

export { loadWorkflowFile, parseWorkflowContent } from "./loader.js"
export { resolveConfig } from "./resolve.js"
export { validateDispatchConfig } from "./validate.js"

export function makeWorkflowStoreLive(workflowPath: string): Layer.Layer<WorkflowStore> {
  return Layer.effect(WorkflowStore)(
    Effect.gen(function* () {
      const def = yield* Effect.orDie(loadWorkflowFile(workflowPath))
      const resolved = resolveConfig(def.config)

      const workflowRef = yield* Ref.make<WorkflowDefinition>(def)
      const resolvedRef = yield* Ref.make<ResolvedConfig>(resolved)

      const stopWatcher = yield* watchWorkflowFile(
        workflowPath,
        workflowRef,
        resolvedRef,
        (error: unknown) => {
          process.stderr.write(
            `[WorkflowStore] Invalid reload, keeping last-known-good: ${String(error)}\n`
          )
        }
      )

      yield* Effect.addFinalizer(() => Effect.sync(() => stopWatcher()))

      return {
        get: () => Ref.get(workflowRef),
        getResolved: () => Ref.get(resolvedRef),
      }
    })
  )
}
