import { Effect, Ref } from "effect"
import chokidar from "chokidar"
import { loadWorkflowFile } from "./loader.js"
import { resolveConfig } from "./resolve.js"
import type { WorkflowDefinition, ResolvedConfig } from "../types.js"

export function watchWorkflowFile(
  filePath: string,
  workflowRef: Ref.Ref<WorkflowDefinition>,
  resolvedRef: Ref.Ref<ResolvedConfig>,
  onError: (error: unknown) => void
): Effect.Effect<() => void> {
  return Effect.sync(() => {
    const watcher = chokidar.watch(filePath, { persistent: false, ignoreInitial: true })

    watcher.on("change", () => {
      Effect.runPromise(
        Effect.gen(function* () {
          const def = yield* loadWorkflowFile(filePath)
          const resolved = resolveConfig(def.config)
          yield* Ref.set(workflowRef, def)
          yield* Ref.set(resolvedRef, resolved)
        })
      ).catch((error: unknown) => {
        onError(error)
      })
    })

    return () => {
      void watcher.close()
    }
  })
}
