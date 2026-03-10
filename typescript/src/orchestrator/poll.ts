import { Effect, Ref, Duration, Queue, Schedule } from "effect"
import type { Issue, ResolvedConfig } from "../types.js"
import {
  terminateRunningIssue,
  updateRunningIssueSnapshot,
  releaseClaim,
  addCompleted,
  addRuntimeSeconds,
  removeRunning,
  isActiveState,
  isTerminalState,
  availableGlobalSlots,
  nextAttemptFromRunning,
} from "./state.js"
import {
  sortForDispatch,
  isEligible,
  isRoutableToWorker,
  dispatchIssue,
  scheduleRetry,
  interruptFiber,
  type OrchestratorDeps,
} from "./dispatch.js"
import {
  WorkflowStore,
  TrackerClient,
  WorkspaceManager,
  OrchestratorStateRef,
} from "../services.js"
import { validateDispatchConfig } from "../config/index.js"

// ─── Tick (SPEC.md §16.2) ────────────────────────────────────────────────────

export function tick(): Effect.Effect<void, never, OrchestratorDeps> {
  return Effect.gen(function* () {
    const { ref: stateRef } = yield* OrchestratorStateRef
    const store = yield* WorkflowStore
    const tracker = yield* TrackerClient

    const config = yield* Effect.catch(store.getResolved(), (error) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Failed to get resolved config, skipping tick").pipe(
          Effect.annotateLogs("cause", error.message)
        )
        return null as ResolvedConfig | null
      })
    )
    if (!config) return

    const resolvedAssigneeId = tracker.resolvedAssigneeId

    yield* reconcileRunningIssues()

    const validationErrors = validateDispatchConfig(config)
    if (validationErrors.length > 0) {
      for (const err of validationErrors) {
        yield* Effect.logWarning(`Config validation: ${err.message}`)
      }
      return
    }

    const issues = yield* Effect.catch(
      tracker.fetchCandidateIssues(),
      (error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Failed to fetch candidate issues, skipping dispatch").pipe(
            Effect.annotateLogs("cause", error.message)
          )
          return null as ReadonlyArray<Issue> | null
        })
    )

    if (issues === null) return

    const sorted = sortForDispatch(issues)

    for (const issue of sorted) {
      const state = yield* Ref.get(stateRef)
      if (availableGlobalSlots(state) <= 0) break
      if (isEligible(issue, state, config, resolvedAssigneeId)) {
        yield* dispatchIssue(issue, null)
      }
    }
  })
}

// ─── Poll Loop ────────────────────────────────────────────────────────────────

export function pollLoop(): Effect.Effect<void, never, OrchestratorDeps> {
  return Effect.gen(function* () {
    const store = yield* WorkflowStore
    const { pollTrigger } = yield* OrchestratorStateRef

    const cycle = Effect.gen(function* () {
      yield* tick()
      const intervalMs = yield* Effect.catch(
        store.getResolved().pipe(Effect.map((c) => c.polling.interval_ms)),
        (error) => Effect.logDebug("Failed to read polling interval, using default").pipe(
          Effect.annotateLogs("cause", error.message),
          Effect.andThen(Effect.succeed(30000))
        )
      )
      yield* Effect.race(
        Effect.sleep(Duration.millis(intervalMs)),
        Queue.take(pollTrigger)
      )
    })

    yield* Effect.repeat(cycle, Schedule.forever)
  })
}

// ─── Reconciliation (SPEC.md §16.3) ──────────────────────────────────────────

function reconcileRunningIssues(): Effect.Effect<void, never, OrchestratorDeps | WorkspaceManager> {
  return Effect.gen(function* () {
    const { ref: stateRef } = yield* OrchestratorStateRef
    const store = yield* WorkflowStore
    const config = yield* Effect.orDie(store.getResolved())
    const tracker = yield* TrackerClient
    const resolvedAssigneeId = tracker.resolvedAssigneeId

    yield* reconcileStalls()

    const state = yield* Ref.get(stateRef)
    const runningIds = [...state.running.keys()]
    if (runningIds.length === 0) return

    const refreshed = yield* Effect.catch(
      tracker.fetchIssueStatesByIds(runningIds),
      (error) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("Failed to refresh running issue states, keeping active workers").pipe(
            Effect.annotateLogs("cause", error.message)
          )
          return null as ReadonlyArray<Issue> | null
        })
    )

    if (refreshed === null) return

    for (const issue of refreshed) {
      if (isTerminalState(issue.state, config.tracker.terminal_states)) {
        yield* terminateAndCleanup(issue.id, true)
      } else if (!isRoutableToWorker(issue, resolvedAssigneeId)) {
        yield* Effect.logInfo(`Issue no longer routed to this worker: ${issue.identifier} assignee=${issue.assignee_id}`)
        yield* terminateAndCleanup(issue.id, false)
      } else if (isActiveState(issue.state, config.tracker.active_states)) {
        yield* Ref.update(stateRef, (s) => updateRunningIssueSnapshot(s, issue))
      } else {
        yield* terminateAndCleanup(issue.id, false)
      }
    }
  })
}

function reconcileStalls(): Effect.Effect<void, never, OrchestratorDeps> {
  return Effect.gen(function* () {
    const { ref: stateRef } = yield* OrchestratorStateRef
    const store = yield* WorkflowStore
    const config = yield* Effect.orDie(store.getResolved())

    const stallTimeoutMs = config.codex.stall_timeout_ms
    if (stallTimeoutMs <= 0) return

    const state = yield* Ref.get(stateRef)
    if (state.running.size === 0) return

    const now = Date.now()
    const toStall: Array<{ issueId: string; elapsedMs: number }> = []

    for (const [issueId, entry] of state.running) {
      const referenceTime = entry.last_codex_timestamp
        ? entry.last_codex_timestamp.getTime()
        : entry.started_at.getTime()
      const elapsed = now - referenceTime
      if (elapsed > stallTimeoutMs) {
        toStall.push({ issueId, elapsedMs: elapsed })
      }
    }

    for (const { issueId, elapsedMs } of toStall) {
      yield* Effect.logWarning(`Issue stalled: issue_id=${issueId} elapsed_ms=${elapsedMs}`)

      const entry = yield* Ref.modify(stateRef, (s) => {
        const runningEntry = s.running.get(issueId)
        if (!runningEntry) return [null, s] as const
        return [runningEntry, terminateRunningIssue(s, issueId).state] as const
      })
      if (!entry) continue

      const nextAttempt = nextAttemptFromRunning(entry)

      yield* interruptFiber(entry.worker_fiber)

      yield* scheduleRetry(issueId, nextAttempt ?? 1, {
        identifier: entry.identifier,
        error: `stalled for ${elapsedMs}ms without activity`,
      })
    }
  })
}

function terminateAndCleanup(
  issueId: string,
  cleanupWorkspace: boolean
): Effect.Effect<void, never, WorkspaceManager | OrchestratorStateRef> {
  return Effect.gen(function* () {
    const { ref: stateRef } = yield* OrchestratorStateRef

    const entry = yield* Ref.modify(stateRef, (s) => {
      const runningEntry = s.running.get(issueId)
      if (!runningEntry) return [null, releaseClaim(s, issueId)] as const
      return [runningEntry, s] as const
    })
    if (!entry) return

    yield* interruptFiber(entry.worker_fiber)

    if (cleanupWorkspace) {
      const workspaceManager = yield* WorkspaceManager
      yield* Effect.catch(
        workspaceManager.removeForIssue(entry.identifier),
        (error) => Effect.logDebug("workspace cleanup failed (best-effort)").pipe(Effect.annotateLogs("cause", error.message))
      )
    }

    yield* Ref.update(stateRef, (s) => terminateRunningIssue(s, issueId).state)
  })
}

// ─── Worker Exit Handling (SPEC.md §16.6) ─────────────────────────────────────

export function handleWorkerExit(
  issueId: string,
  normal: boolean
): Effect.Effect<void, never, OrchestratorDeps> {
  return Effect.gen(function* () {
    const { ref: stateRef } = yield* OrchestratorStateRef
    const store = yield* WorkflowStore
    const config = yield* Effect.orDie(store.getResolved())

    const entry = yield* Ref.modify(stateRef, (s) => {
      const e = s.running.get(issueId)
      if (!e) return [null, s] as const
      const s2 = addRuntimeSeconds(s, e)
      return [e, removeRunning(s2, issueId).state] as const
    })
    if (!entry) return

    if (normal) {
      yield* Ref.update(stateRef, (s) => addCompleted(s, issueId))
      yield* scheduleRetry(issueId, 1, {
        identifier: entry.identifier,
        error: null,
        isContinuation: true,
      })
    } else {
      const nextAttempt = nextAttemptFromRunning(entry)
      yield* scheduleRetry(issueId, nextAttempt ?? 1, {
        identifier: entry.identifier,
        error: "worker exited abnormally",
      })
    }
  })
}

// ─── Startup Terminal Cleanup (SPEC.md §8.6) ──────────────────────────────────

export function startupTerminalCleanup(): Effect.Effect<void, never, TrackerClient | WorkspaceManager | WorkflowStore> {
  return Effect.gen(function* () {
    const store = yield* WorkflowStore
    const config = yield* Effect.orDie(store.getResolved())
    const tracker = yield* TrackerClient
    const workspaceManager = yield* WorkspaceManager

    const issues = yield* Effect.catch(
      tracker.fetchIssuesByStates(config.tracker.terminal_states),
      (error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Startup terminal cleanup: failed to fetch terminal issues, continuing").pipe(
            Effect.annotateLogs("cause", error.message)
          )
          return [] as ReadonlyArray<Issue>
        })
    )

    for (const issue of issues) {
      if (issue.identifier) {
        yield* Effect.catch(
          workspaceManager.removeForIssue(issue.identifier),
          (error) => Effect.logDebug("startup workspace cleanup failed (best-effort)").pipe(Effect.annotateLogs("cause", error.message))
        )
      }
    }
  })
}
