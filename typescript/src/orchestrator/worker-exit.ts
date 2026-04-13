import { Effect, Ref } from "effect"
import type { Issue } from "../types.js"
import {
  addCompleted,
  addRuntimeSeconds,
  nextAttemptFromRunning,
  releaseClaim,
  removeRunning,
} from "./state.js"
import {
  OrchestratorStateRef,
  TrackerClient,
  WorkflowStore,
  WorkspaceManager,
} from "../services.js"
import type { OrchestratorDeps } from "./dispatch.js"
import { scheduleRetry } from "./dispatch.js"

export function handleWorkerExit(
  issueId: string,
  normal: boolean
): Effect.Effect<void, never, OrchestratorDeps> {
  return Effect.gen(function* () {
    const { ref: stateRef } = yield* OrchestratorStateRef
    const store = yield* WorkflowStore
    const tracker = yield* TrackerClient
    const workspaceManager = yield* WorkspaceManager
    yield* Effect.orDie(store.getResolved())

    const entry = yield* Ref.modify(stateRef, (s) => {
      const e = s.running.get(issueId)
      if (!e) return [null, s] as const
      const s2 = addRuntimeSeconds(s, e)
      return [e, removeRunning(s2, issueId).state] as const
    })
    if (!entry) return

    if (normal) {
      const completedIssue = yield* Effect.catch(
        tracker.transitionIssueToCompleted(issueId),
        (error) =>
          Effect.logWarning(`Failed to move ${entry.identifier} to terminal tracker state`).pipe(
            Effect.annotateLogs("cause", error.message),
            Effect.as(null as Issue | null),
          ),
      )

      if (completedIssue) {
        yield* Effect.catch(
          workspaceManager.removeForIssue(entry.identifier),
          (error) => Effect.logDebug("workspace cleanup failed after successful completion").pipe(
            Effect.annotateLogs("cause", error.message),
          ),
        )
        yield* Ref.update(stateRef, (s) => addCompleted(releaseClaim(s, issueId), issueId))
      } else {
        yield* Ref.update(stateRef, (s) => addCompleted(s, issueId))
        yield* scheduleRetry(issueId, 1, {
          identifier: entry.identifier,
          error: null,
          isContinuation: true,
        })
      }
    } else {
      const nextAttempt = nextAttemptFromRunning(entry)
      yield* scheduleRetry(issueId, nextAttempt ?? 1, {
        identifier: entry.identifier,
        error: "worker exited abnormally",
      })
    }
  })
}
