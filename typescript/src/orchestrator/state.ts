import type {
  OrchestratorState,
  RunningEntry,
  RetryEntry,
  TokenTotals,
  Issue,
  RecentAgentEvent,
} from "../types.js"
import type { Fiber } from "effect"

// ─── Initial State ────────────────────────────────────────────────────────────

const EMPTY_TOTALS: TokenTotals = {
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  seconds_running: 0,
}

const MAX_RECENT_AGENT_EVENTS = 50

export function makeInitialState(
  pollIntervalMs: number,
  maxConcurrentAgents: number
): OrchestratorState {
  return {
    poll_interval_ms: pollIntervalMs,
    max_concurrent_agents: maxConcurrentAgents,
    running: new Map<string, RunningEntry>(),
    claimed: new Set<string>(),
    retry_attempts: new Map<string, RetryEntry>(),
    completed: new Set<string>(),
    codex_totals: EMPTY_TOTALS,
    codex_rate_limits: null,
  }
}

// ─── Running Map Helpers ──────────────────────────────────────────────────────

export function addRunning(
  state: OrchestratorState,
  issueId: string,
  entry: RunningEntry
): OrchestratorState {
  const running = new Map(state.running)
  running.set(issueId, entry)
  const claimed = new Set(state.claimed)
  claimed.add(issueId)
  const retry_attempts = new Map(state.retry_attempts)
  retry_attempts.delete(issueId)
  return { ...state, running, claimed, retry_attempts }
}

export function removeRunning(
  state: OrchestratorState,
  issueId: string
): { entry: RunningEntry | undefined; state: OrchestratorState } {
  const entry = state.running.get(issueId)
  if (!entry) return { entry: undefined, state }
  const running = new Map(state.running)
  running.delete(issueId)
  return { entry, state: { ...state, running } }
}

export function updateRunningEntry(
  state: OrchestratorState,
  issueId: string,
  updater: (entry: RunningEntry) => RunningEntry
): OrchestratorState {
  const entry = state.running.get(issueId)
  if (!entry) return state
  const running = new Map(state.running)
  running.set(issueId, updater(entry))
  return { ...state, running }
}

export function updateRunningIssueSnapshot(
  state: OrchestratorState,
  issue: Issue
): OrchestratorState {
  return updateRunningEntry(state, issue.id, (entry) => ({
    ...entry,
    issue,
  }))
}

export function appendRecentAgentEvent(
  state: OrchestratorState,
  issueId: string,
  event: RecentAgentEvent
): OrchestratorState {
  return updateRunningEntry(state, issueId, (entry) => ({
    ...entry,
    recent_agent_events: [...entry.recent_agent_events, event].slice(
      -MAX_RECENT_AGENT_EVENTS
    ),
  }))
}

// ─── Claimed Set Helpers ──────────────────────────────────────────────────────

export function releaseClaim(
  state: OrchestratorState,
  issueId: string
): OrchestratorState {
  const claimed = new Set(state.claimed)
  claimed.delete(issueId)
  return { ...state, claimed }
}

// ─── Completed Set Helpers ────────────────────────────────────────────────────

export function addCompleted(
  state: OrchestratorState,
  issueId: string
): OrchestratorState {
  const completed = new Set(state.completed)
  completed.add(issueId)
  return { ...state, completed }
}

// ─── Retry Map Helpers ────────────────────────────────────────────────────────

export function setRetryEntry(
  state: OrchestratorState,
  issueId: string,
  entry: RetryEntry
): OrchestratorState {
  const retry_attempts = new Map(state.retry_attempts)
  retry_attempts.set(issueId, entry)
  return { ...state, retry_attempts }
}

export function removeRetryEntry(
  state: OrchestratorState,
  issueId: string
): { entry: RetryEntry | undefined; state: OrchestratorState } {
  const entry = state.retry_attempts.get(issueId)
  if (!entry) return { entry: undefined, state }
  const retry_attempts = new Map(state.retry_attempts)
  retry_attempts.delete(issueId)
  return { entry, state: { ...state, retry_attempts } }
}

// ─── Token / Rate Limit Helpers ───────────────────────────────────────────────

export function addRuntimeSeconds(
  state: OrchestratorState,
  entry: RunningEntry
): OrchestratorState {
  const now = new Date()
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now.getTime() - entry.started_at.getTime()) / 1000)
  )
  return {
    ...state,
    codex_totals: {
      ...state.codex_totals,
      seconds_running: state.codex_totals.seconds_running + elapsedSeconds,
    },
  }
}

export function addTokenDelta(
  state: OrchestratorState,
  input: number,
  output: number,
  total: number
): OrchestratorState {
  return {
    ...state,
    codex_totals: {
      input_tokens: state.codex_totals.input_tokens + input,
      output_tokens: state.codex_totals.output_tokens + output,
      total_tokens: state.codex_totals.total_tokens + total,
      seconds_running: state.codex_totals.seconds_running,
    },
  }
}

export function setRateLimits(
  state: OrchestratorState,
  rateLimits: unknown
): OrchestratorState {
  return { ...state, codex_rate_limits: rateLimits }
}

// ─── Terminate Running Issue ──────────────────────────────────────────────────

export function terminateRunningIssue(
  state: OrchestratorState,
  issueId: string
): { entry: RunningEntry | undefined; state: OrchestratorState } {
  const entry = state.running.get(issueId)
  if (!entry) {
    return { entry: undefined, state: releaseClaim(state, issueId) }
  }

  let newState = addRuntimeSeconds(state, entry)

  const running = new Map(newState.running)
  running.delete(issueId)
  newState = { ...newState, running }

  const claimed = new Set(newState.claimed)
  claimed.delete(issueId)
  newState = { ...newState, claimed }

  const retry_attempts = new Map(newState.retry_attempts)
  retry_attempts.delete(issueId)
  newState = { ...newState, retry_attempts }

  return { entry, state: newState }
}

// ─── Normalization Helpers ────────────────────────────────────────────────────

export function normalizeState(stateName: string): string {
  return stateName.trim().toLowerCase()
}

export function isActiveState(
  stateName: string,
  activeStates: ReadonlyArray<string>
): boolean {
  const normalized = normalizeState(stateName)
  return activeStates.some((s) => normalizeState(s) === normalized)
}

export function isTerminalState(
  stateName: string,
  terminalStates: ReadonlyArray<string>
): boolean {
  const normalized = normalizeState(stateName)
  return terminalStates.some((s) => normalizeState(s) === normalized)
}

// ─── Slot Counting ────────────────────────────────────────────────────────────

export function availableGlobalSlots(state: OrchestratorState): number {
  return Math.max(state.max_concurrent_agents - state.running.size, 0)
}

export function runningCountForState(
  running: ReadonlyMap<string, RunningEntry>,
  stateName: string
): number {
  const normalized = normalizeState(stateName)
  let count = 0
  for (const [, entry] of running) {
    if (normalizeState(entry.issue.state) === normalized) {
      count++
    }
  }
  return count
}

// ─── Retry Delay Calculation (SPEC.md §8.4) ──────────────────────────────────

const CONTINUATION_RETRY_DELAY_MS = 1_000
const FAILURE_RETRY_BASE_MS = 10_000

export function retryDelay(
  attempt: number,
  isContinuation: boolean,
  maxRetryBackoffMs: number
): number {
  if (isContinuation && attempt === 1) {
    return CONTINUATION_RETRY_DELAY_MS
  }
  const maxPower = Math.min(attempt - 1, 30) // cap to avoid overflow
  return Math.min(FAILURE_RETRY_BASE_MS * Math.pow(2, maxPower), maxRetryBackoffMs)
}

export function normalizeAttempt(attempt: number | null): number {
  return typeof attempt === "number" && attempt > 0 ? attempt : 0
}

export function nextAttemptFromRunning(entry: RunningEntry): number | null {
  const attempt = entry.retry_attempt
  return typeof attempt === "number" && attempt > 0 ? attempt + 1 : null
}

// ─── Make Running Entry ───────────────────────────────────────────────────────

export function makeRunningEntry(
  issue: Issue,
  workspacePath: string,
  attempt: number | null,
  workerFiber: Fiber.Fiber<void, unknown>
): RunningEntry {
  return {
    issue_id: issue.id,
    identifier: issue.identifier,
    issue,
    session_id: null,
    thread_id: null,
    turn_id: null,
    codex_app_server_pid: null,
    last_codex_event: null,
    last_codex_timestamp: null,
    last_codex_message: null,
    codex_input_tokens: 0,
    codex_output_tokens: 0,
    codex_total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    turn_count: 0,
    retry_attempt: normalizeAttempt(attempt),
    started_at: new Date(),
    workspace_path: workspacePath,
    recent_agent_events: [],
    worker_fiber: workerFiber,
  }
}
