import { Effect, Ref, Fiber, Duration } from "effect"
import type { Issue, OrchestratorState, ResolvedConfig, RetryEntry } from "../types.js"
import {
  normalizeState,
  isActiveState,
  isTerminalState,
  availableGlobalSlots,
  runningCountForState,
  addRunning,
  makeRunningEntry,
  setRetryEntry,
  removeRetryEntry,
  releaseClaim,
  retryDelay,
} from "./state.js"
import { runWorker } from "./worker.js"
import {
  WorkspaceManager,
  TrackerClient,
  WorkflowStore,
  OrchestratorStateRef,
  PromptEngine,
} from "../services.js"
import { AgentEngine } from "../engine/agent.js"

// ─── Sort ─────────────────────────────────────────────────────────────────────

function priorityRank(priority: number | null): number {
  if (typeof priority === "number" && priority >= 1 && priority <= 4) return priority
  return 5
}

function createdAtSortKey(issue: Issue): number {
  if (issue.created_at) return issue.created_at.getTime()
  return Number.MAX_SAFE_INTEGER
}

export function sortForDispatch(issues: ReadonlyArray<Issue>): ReadonlyArray<Issue> {
  return [...issues].sort((a, b) => {
    const pA = priorityRank(a.priority)
    const pB = priorityRank(b.priority)
    if (pA !== pB) return pA - pB

    const cA = createdAtSortKey(a)
    const cB = createdAtSortKey(b)
    if (cA !== cB) return cA - cB

    return (a.identifier ?? a.id ?? "").localeCompare(b.identifier ?? b.id ?? "")
  })
}

// ─── Eligibility (SPEC.md §8.2) ──────────────────────────────────────────────

export function isRoutableToWorker(issue: Issue, resolvedAssigneeId: string | null): boolean {
  if (resolvedAssigneeId === null) return true
  return issue.assignee_id === resolvedAssigneeId
}

export function isEligible(
  issue: Issue,
  state: OrchestratorState,
  config: ResolvedConfig,
  resolvedAssigneeId: string | null = null
): boolean {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false

  const activeStates = config.tracker.active_states
  const terminalStates = config.tracker.terminal_states

  if (!isActiveState(issue.state, activeStates)) return false
  if (isTerminalState(issue.state, terminalStates)) return false
  if (state.running.has(issue.id)) return false
  if (state.claimed.has(issue.id)) return false
  if (availableGlobalSlots(state) <= 0) return false
  if (!stateSlotAvailable(issue, state, config)) return false
  if (isTodoBlockedByNonTerminal(issue, terminalStates)) return false
  if (!isRoutableToWorker(issue, resolvedAssigneeId)) return false

  return true
}

function stateSlotAvailable(
  issue: Issue,
  state: OrchestratorState,
  config: ResolvedConfig
): boolean {
  const normalized = normalizeState(issue.state)
  const byState = config.agent.max_concurrent_agents_by_state
  const limit = byState[normalized] ?? config.agent.max_concurrent_agents
  const used = runningCountForState(state.running, issue.state)
  return limit > used
}

function isTodoBlockedByNonTerminal(
  issue: Issue,
  terminalStates: ReadonlyArray<string>
): boolean {
  if (normalizeState(issue.state) !== "todo") return false
  if (!issue.blocked_by || issue.blocked_by.length === 0) return false
  return issue.blocked_by.some((blocker) => {
    if (!blocker.state) return true
    return !isTerminalState(blocker.state, terminalStates)
  })
}

// ─── Dispatch (SPEC.md §16.4) ─────────────────────────────────────────────────

export type OrchestratorDeps =
  | WorkflowStore
  | TrackerClient
  | WorkspaceManager
  | OrchestratorStateRef
  | PromptEngine
  | AgentEngine

export function dispatchIssue(
  stateRef: Ref.Ref<OrchestratorState>,
  issue: Issue,
  attempt: number | null,
  config: ResolvedConfig
): Effect.Effect<void, never, OrchestratorDeps> {
  return Effect.gen(function* () {
    const workerEffect = runWorker(stateRef, issue, attempt, config)

    const fiber = yield* Effect.catchCause(
      Effect.map(Effect.forkChild(workerEffect), (f): Fiber.Fiber<void, unknown> => f as Fiber.Fiber<void, unknown>),
      () =>
        Effect.gen(function* () {
          yield* Effect.logWarning(`Failed to spawn worker for ${issue.identifier}`)
          const nextAttempt = typeof attempt === "number" ? attempt + 1 : 1
          yield* scheduleRetry(stateRef, issue.id, nextAttempt, config, {
            identifier: issue.identifier,
            error: "failed to spawn agent",
          })
          return null as unknown as Fiber.Fiber<void, unknown>
        })
    )

    if (!fiber) return

    yield* Ref.update(stateRef, (s) =>
      addRunning(s, issue.id, makeRunningEntry(issue, "", attempt, fiber))
    )

    yield* Effect.logInfo(`Dispatched issue ${issue.identifier} attempt=${attempt}`)
  })
}

// ─── Retry Scheduling (SPEC.md §8.4) ─────────────────────────────────────────

interface RetryMeta {
  readonly identifier: string
  readonly error: string | null
  readonly isContinuation?: boolean
}

export function scheduleRetry(
  stateRef: Ref.Ref<OrchestratorState>,
  issueId: string,
  attempt: number,
  config: ResolvedConfig,
  meta: RetryMeta
): Effect.Effect<void, never, OrchestratorDeps> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(stateRef)
    const existingRetry = state.retry_attempts.get(issueId)
    if (existingRetry?.timer_handle) {
      yield* interruptFiber(existingRetry.timer_handle)
    }

    const delayMs = retryDelay(
      attempt,
      meta.isContinuation === true && attempt === 1,
      config.agent.max_retry_backoff_ms
    )

    const dueAtMs = Date.now() + delayMs

    const timerFiber = yield* Effect.forkChild(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(delayMs))
        yield* handleRetryTimer(stateRef, issueId, config)
      })
    )

    yield* Effect.logDebug(
      `Retry scheduled: issue_id=${issueId} identifier=${meta.identifier} attempt=${attempt} delay=${delayMs}ms`
    )

    const retryEntry: RetryEntry = {
      issue_id: issueId,
      identifier: meta.identifier,
      attempt,
      due_at_ms: dueAtMs,
      error: meta.error,
      timer_handle: timerFiber,
    }

    yield* Ref.update(stateRef, (s) => setRetryEntry(s, issueId, retryEntry))
  })
}

// ─── Retry Timer Handler (SPEC.md §16.6) ─────────────────────────────────────

function handleRetryTimer(
  stateRef: Ref.Ref<OrchestratorState>,
  issueId: string,
  config: ResolvedConfig
): Effect.Effect<void, never, OrchestratorDeps> {
  return Effect.gen(function* () {
    const tracker = yield* TrackerClient
    const obsRef = yield* OrchestratorStateRef

    const popResult = yield* Ref.modify(stateRef, (s) => {
      const result = removeRetryEntry(s, issueId)
      return [result.entry, result.state] as const
    })

    if (!popResult) return

    const candidates = yield* Effect.catchCause(
      tracker.fetchCandidateIssues(),
      () =>
        Effect.gen(function* () {
          yield* scheduleRetry(stateRef, issueId, popResult.attempt + 1, config, {
            identifier: popResult.identifier,
            error: "retry poll failed",
          })
          return null as ReadonlyArray<Issue> | null
        })
    )

    if (candidates === null) return

    const issue = candidates.find((i: Issue) => i.id === issueId)
    if (!issue) {
      yield* Ref.update(stateRef, (s) => releaseClaim(s, issueId))
      return
    }

    const state = yield* Ref.get(stateRef)
    if (availableGlobalSlots(state) <= 0) {
      yield* scheduleRetry(stateRef, issueId, popResult.attempt + 1, config, {
        identifier: issue.identifier,
        error: "no available orchestrator slots",
      })
      return
    }

    const normalizedIssueSate = normalizeState(issue.state)
    const byState = config.agent.max_concurrent_agents_by_state
    const perStateLimit = byState[normalizedIssueSate]
    if (perStateLimit !== undefined) {
      const used = runningCountForState(state.running, issue.state)
      if (used >= perStateLimit) {
        yield* scheduleRetry(stateRef, issueId, popResult.attempt + 1, config, {
          identifier: issue.identifier,
          error: "no available orchestrator slots (per-state limit)",
        })
        return
      }
    }

    yield* dispatchIssue(stateRef, issue, popResult.attempt, config)

    const current = yield* Ref.get(stateRef)
    yield* Ref.set(obsRef.ref, current)
  })
}

export function interruptFiber(fiber: unknown): Effect.Effect<void> {
  if (fiber && typeof fiber === "object" && "id" in fiber) {
    return Effect.catchCause(
      Fiber.interrupt(fiber as Fiber.Fiber<unknown, unknown>),
      () => Effect.void
    ) as Effect.Effect<void>
  }
  return Effect.void
}
