import { Effect, Ref, Duration, Schedule } from "effect"
import type { Issue, OrchestratorState, ResolvedConfig } from "../types.js"
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

export function tick(
  stateRef: Ref.Ref<OrchestratorState>
): Effect.Effect<void, never, OrchestratorDeps> {
  return Effect.gen(function* () {
    const store = yield* WorkflowStore
    const tracker = yield* TrackerClient
    const obsRef = yield* OrchestratorStateRef

    const config = yield* Effect.catchCause(store.getResolved(), () =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Failed to get resolved config, skipping tick")
        return null as ResolvedConfig | null
      })
    )
    if (!config) {
      yield* notifyObservers(stateRef, obsRef)
      return
    }

    yield* reconcileRunningIssues(stateRef, config, tracker)

    const validationErrors = validateDispatchConfig(config)
    if (validationErrors.length > 0) {
      for (const err of validationErrors) {
        yield* Effect.logWarning(`Config validation: ${err.message}`)
      }
      yield* notifyObservers(stateRef, obsRef)
      return
    }

    const issues = yield* Effect.catchCause(
      tracker.fetchCandidateIssues(),
      () =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Failed to fetch candidate issues, skipping dispatch")
          return null as ReadonlyArray<Issue> | null
        })
    )

    if (issues === null) {
      yield* notifyObservers(stateRef, obsRef)
      return
    }

    const sorted = sortForDispatch(issues)

    for (const issue of sorted) {
      const state = yield* Ref.get(stateRef)
      if (availableGlobalSlots(state) <= 0) break
      if (isEligible(issue, state, config)) {
        yield* dispatchIssue(stateRef, issue, null, config)
      }
    }

    yield* notifyObservers(stateRef, obsRef)
  })
}

function notifyObservers(
  stateRef: Ref.Ref<OrchestratorState>,
  obsRef: { readonly ref: Ref.Ref<OrchestratorState> }
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const current = yield* Ref.get(stateRef)
    yield* Ref.set(obsRef.ref, current)
  })
}

// ─── Poll Loop ────────────────────────────────────────────────────────────────

export function pollLoop(
  stateRef: Ref.Ref<OrchestratorState>,
  pollIntervalMs: number
): Effect.Effect<never, never, OrchestratorDeps> {
  const oneTick = tick(stateRef)
  return Effect.repeat(
    oneTick,
    Schedule.spaced(Duration.millis(pollIntervalMs))
  ) as Effect.Effect<never, never, OrchestratorDeps>
}

// ─── Reconciliation (SPEC.md §16.3) ──────────────────────────────────────────

function reconcileRunningIssues(
  stateRef: Ref.Ref<OrchestratorState>,
  config: ResolvedConfig,
  tracker: {
    fetchIssueStatesByIds(ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<Issue>, unknown>
  }
): Effect.Effect<void, never, OrchestratorDeps | WorkspaceManager> {
  return Effect.gen(function* () {
    yield* reconcileStalls(stateRef, config)

    const state = yield* Ref.get(stateRef)
    const runningIds = [...state.running.keys()]
    if (runningIds.length === 0) return

    const refreshed = yield* Effect.catchCause(
      tracker.fetchIssueStatesByIds(runningIds),
      () =>
        Effect.gen(function* () {
          yield* Effect.logDebug("Failed to refresh running issue states, keeping active workers")
          return null as ReadonlyArray<Issue> | null
        })
    )

    if (refreshed === null) return

    for (const issue of refreshed) {
      if (isTerminalState(issue.state, config.tracker.terminal_states)) {
        yield* terminateAndCleanup(stateRef, issue.id, true)
      } else if (isActiveState(issue.state, config.tracker.active_states)) {
        yield* Ref.update(stateRef, (s) => updateRunningIssueSnapshot(s, issue))
      } else {
        yield* terminateAndCleanup(stateRef, issue.id, false)
      }
    }
  })
}

function reconcileStalls(
  stateRef: Ref.Ref<OrchestratorState>,
  config: ResolvedConfig
): Effect.Effect<void, never, OrchestratorDeps> {
  return Effect.gen(function* () {
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

      const currentState = yield* Ref.get(stateRef)
      const entry = currentState.running.get(issueId)
      if (!entry) continue

      const nextAttempt = nextAttemptFromRunning(entry)

      yield* interruptFiber(entry.worker_fiber)
      yield* Ref.update(stateRef, (s) => terminateRunningIssue(s, issueId).state)

      yield* scheduleRetry(stateRef, issueId, nextAttempt ?? 1, config, {
        identifier: entry.identifier,
        error: `stalled for ${elapsedMs}ms without activity`,
      })
    }
  })
}

function terminateAndCleanup(
  stateRef: Ref.Ref<OrchestratorState>,
  issueId: string,
  cleanupWorkspace: boolean
): Effect.Effect<void, never, WorkspaceManager> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(stateRef)
    const entry = state.running.get(issueId)
    if (!entry) {
      yield* Ref.update(stateRef, (s) => releaseClaim(s, issueId))
      return
    }

    yield* interruptFiber(entry.worker_fiber)

    if (cleanupWorkspace) {
      const workspaceManager = yield* WorkspaceManager
      yield* Effect.catchCause(
        workspaceManager.removeForIssue(entry.identifier),
        () => Effect.void
      )
    }

    yield* Ref.update(stateRef, (s) => terminateRunningIssue(s, issueId).state)
  })
}

// ─── Worker Exit Handling (SPEC.md §16.6) ─────────────────────────────────────

export function handleWorkerExit(
  stateRef: Ref.Ref<OrchestratorState>,
  issueId: string,
  normal: boolean,
  config: ResolvedConfig
): Effect.Effect<void, never, OrchestratorDeps> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(stateRef)
    const entry = state.running.get(issueId)
    if (!entry) return

    yield* Ref.update(stateRef, (s) => {
      const s2 = addRuntimeSeconds(s, entry)
      return removeRunning(s2, issueId).state
    })

    if (normal) {
      yield* Ref.update(stateRef, (s) => addCompleted(s, issueId))
      yield* scheduleRetry(stateRef, issueId, 1, config, {
        identifier: entry.identifier,
        error: null,
        isContinuation: true,
      })
    } else {
      const nextAttempt = nextAttemptFromRunning(entry)
      yield* scheduleRetry(stateRef, issueId, nextAttempt ?? 1, config, {
        identifier: entry.identifier,
        error: "worker exited abnormally",
      })
    }
  })
}

// ─── Startup Terminal Cleanup (SPEC.md §8.6) ──────────────────────────────────

export function startupTerminalCleanup(
  config: ResolvedConfig
): Effect.Effect<void, never, TrackerClient | WorkspaceManager> {
  return Effect.gen(function* () {
    const tracker = yield* TrackerClient
    const workspaceManager = yield* WorkspaceManager

    const issues = yield* Effect.catchCause(
      tracker.fetchIssuesByStates(config.tracker.terminal_states),
      () =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Startup terminal cleanup: failed to fetch terminal issues, continuing")
          return [] as ReadonlyArray<Issue>
        })
    )

    for (const issue of issues) {
      if (issue.identifier) {
        yield* Effect.catchCause(
          workspaceManager.removeForIssue(issue.identifier),
          () => Effect.void
        )
      }
    }
  })
}
