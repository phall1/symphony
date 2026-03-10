/**
 * Orchestrator conformance tests — covers SPEC.md §17.4 bullets:
 *   - Dispatch sort order
 *   - Todo eligibility with blockers
 *   - Active-state snapshot update
 *   - Non-active / terminal reconciliation behaviour
 *   - Normal / abnormal worker exit retry scheduling
 *   - Retry backoff formula and cap
 *   - Retry queue entry shape
 *   - Stall detection
 *   - Slot exhaustion
 *   - Snapshot API shape
 */

import { describe, it, expect } from "vitest"
import { Effect, Layer, Ref, Queue } from "effect"
import type { Fiber } from "effect"
import type {
  Issue,
  OrchestratorState,
  ResolvedConfig,
  Workspace,
} from "../types.js"
import { sortForDispatch, isEligible } from "../orchestrator/dispatch.js"
import {
  retryDelay,
  makeInitialState,
  addRunning,
  makeRunningEntry,
  updateRunningIssueSnapshot,
  setRetryEntry,
  availableGlobalSlots,
} from "../orchestrator/state.js"
import { handleWorkerExit, tick } from "../orchestrator/poll.js"
import { buildSnapshot } from "../observability/snapshot.js"
import {
  WorkflowStore,
  TrackerClient,
  WorkspaceManager,
  OrchestratorStateRef,
  PromptEngine,
} from "../services.js"
import { AgentEngine, AgentEngineError } from "../engine/agent.js"

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ABC-1",
    title: "Test Issue",
    description: null,
    priority: null,
    state: "Todo",
    branch_name: null,
    url: null,
    assignee_id: null,
    labels: [],
    blocked_by: [],
    created_at: new Date("2024-01-01"),
    updated_at: null,
    ...overrides,
  }
}

function makeConfig(
  overrides: {
    tracker?: Partial<ResolvedConfig["tracker"]>
    polling?: Partial<ResolvedConfig["polling"]>
    workspace?: Partial<ResolvedConfig["workspace"]>
    hooks?: Partial<ResolvedConfig["hooks"]>
    agent?: Partial<ResolvedConfig["agent"]>
    codex?: Partial<ResolvedConfig["codex"]>
    opencode?: Partial<ResolvedConfig["opencode"]>
    server?: Partial<ResolvedConfig["server"]>
  } = {}
): ResolvedConfig {
  return {
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "test-key",
      project_slug: "TEST",
      active_states: ["Todo", "InProgress"],
      terminal_states: ["Done", "Cancelled"],
      assignee: null,
      ...(overrides.tracker ?? {}),
    },
    polling: { interval_ms: 5000, ...(overrides.polling ?? {}) },
    workspace: { root: "/tmp/workspaces", ...(overrides.workspace ?? {}) },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 30000,
      ...(overrides.hooks ?? {}),
    },
    agent: {
      max_concurrent_agents: 10,
      max_turns: 20,
      max_retry_backoff_ms: 300_000,
      max_concurrent_agents_by_state: {},
      engine: "codex",
      ...(overrides.agent ?? {}),
    },
    codex: {
      command: "codex",
      approval_policy: "auto-approve-except-special-files",
      thread_sandbox: "none",
      turn_sandbox_policy: "none",
      turn_timeout_ms: 600_000,
      read_timeout_ms: 10_000,
      stall_timeout_ms: 0,
      ...(overrides.codex ?? {}),
    },
    opencode: {
      mode: "per-workspace",
      server_url: null,
      model: "claude-3-5-sonnet-latest",
      agent: "symphony",
      port: 0,
      ...(overrides.opencode ?? {}),
    },
    server: { port: null, host: "127.0.0.1", ...(overrides.server ?? {}) },
  }
}

const DUMMY_FIBER = {} as unknown as Fiber.Fiber<void, unknown>

/**
 * Build all mock service layers needed by tick / handleWorkerExit.
 * @param config       resolved config the WorkflowStore mock returns
 * @param obsRef       ref used for OrchestratorStateRef (observation side)
 * @param opts.candidateIssues   issues returned by fetchCandidateIssues
 * @param opts.refreshedIssues   issues returned by fetchIssueStatesByIds
 * @param opts.onRemoveForIssue  callback called whenever removeForIssue is invoked
 * @param opts.onFetchIssueStatesByIds  callback called with ids when fetched
 */
function makeMockLayers(
  config: ResolvedConfig,
  obsRef: Ref.Ref<OrchestratorState>,
  opts: {
    candidateIssues?: Issue[]
    refreshedIssues?: Issue[]
    onRemoveForIssue?: (identifier: string) => void
    onFetchIssueStatesByIds?: (ids: ReadonlyArray<string>) => void
  } = {}
) {
  return Layer.mergeAll(
    Layer.succeed(WorkflowStore, {
      get: () =>
        Effect.succeed({ config: {}, prompt_template: "test" }),
      getResolved: () => Effect.succeed(config),
    }),
    Layer.succeed(TrackerClient, {
      fetchCandidateIssues: () =>
        Effect.succeed(opts.candidateIssues ?? []),
      fetchIssueStatesByIds: (ids) => {
        opts.onFetchIssueStatesByIds?.(ids)
        return Effect.succeed(opts.refreshedIssues ?? [])
      },
      fetchIssuesByStates: (_states) => Effect.succeed([]),
      resolvedAssigneeId: null,
    }),
    Layer.succeed(WorkspaceManager, {
      createForIssue: (id) =>
        Effect.succeed({
          path: `/tmp/ws/${id}`,
          workspace_key: id,
          created_now: true,
        } as Workspace),
      removeForIssue: (identifier) => {
        opts.onRemoveForIssue?.(identifier)
        return Effect.void
      },
      runHook: (_hook, _path) => Effect.void,
    }),
    Layer.effect(OrchestratorStateRef)(
      Effect.map(Queue.unbounded<void>(), (q) => ({ ref: obsRef, pollTrigger: q }))
    ),
    Layer.succeed(PromptEngine, {
      render: (_template, _issue, _attempt) => Effect.succeed("test prompt"),
    }),
    Layer.succeed(AgentEngine, {
      createSession: (_input) =>
        Effect.fail(new AgentEngineError({ message: "mock" })),
    })
  )
}

// ─── §17.4 Test Suite ─────────────────────────────────────────────────────────

// ── Bullet 1: Dispatch sort order ─────────────────────────────────────────────

describe("sortForDispatch — §17.4 bullet 1", () => {
  it("sorts by priority ascending (lower number = higher priority)", () => {
    const hi = makeIssue({ id: "1", identifier: "ABC-1", priority: 1, created_at: new Date("2024-06-01") })
    const lo = makeIssue({ id: "2", identifier: "ABC-2", priority: 3, created_at: new Date("2024-01-01") })
    const sorted = sortForDispatch([lo, hi])
    expect(sorted[0]!.priority).toBe(1)
    expect(sorted[1]!.priority).toBe(3)
  })

  it("within same priority, sorts by oldest created_at first", () => {
    const newer = makeIssue({ id: "2", identifier: "ABC-2", priority: 2, created_at: new Date("2024-06-01") })
    const older = makeIssue({ id: "1", identifier: "ABC-1", priority: 2, created_at: new Date("2024-01-01") })
    const sorted = sortForDispatch([newer, older])
    expect(sorted[0]!.identifier).toBe("ABC-1")  // older first
    expect(sorted[1]!.identifier).toBe("ABC-2")
  })

  it("within same priority and same created_at, sorts by identifier lexicographically", () => {
    const sameTime = new Date("2024-01-01")
    const b = makeIssue({ id: "2", identifier: "ABC-2", priority: 1, created_at: sameTime })
    const a = makeIssue({ id: "1", identifier: "ABC-1", priority: 1, created_at: sameTime })
    const sorted = sortForDispatch([b, a])
    expect(sorted[0]!.identifier).toBe("ABC-1")
    expect(sorted[1]!.identifier).toBe("ABC-2")
  })
})

// ── Bullets 2 & 3: Todo eligibility with blockers ─────────────────────────────

describe("isEligible — §17.4 bullets 2 & 3", () => {
  const config = makeConfig()
  const baseState = makeInitialState(5000, 10)

  it("Todo with non-terminal blocker is NOT eligible", () => {
    const issue = makeIssue({
      state: "Todo",
      blocked_by: [{ id: "b1", identifier: "BLK-1", state: "InProgress" }],  // InProgress is not terminal
    })
    expect(isEligible(issue, baseState, config)).toBe(false)
  })

  it("Todo with terminal blocker IS eligible", () => {
    const issue = makeIssue({
      state: "Todo",
      blocked_by: [{ id: "b1", identifier: "BLK-1", state: "Done" }],  // Done is terminal
    })
    expect(isEligible(issue, baseState, config)).toBe(true)
  })

  it("Todo with no blockers is eligible", () => {
    const issue = makeIssue({ state: "Todo", blocked_by: [] })
    expect(isEligible(issue, baseState, config)).toBe(true)
  })
})

// ── Bullet 4: Active-state refresh updates running entry ──────────────────────

describe("updateRunningIssueSnapshot — §17.4 bullet 4", () => {
  it("updates the issue snapshot in an existing running entry", () => {
    const issue = makeIssue({ state: "Todo" })
    const state = addRunning(
      makeInitialState(5000, 10),
      issue.id,
      makeRunningEntry(issue, "/ws", null, DUMMY_FIBER)
    )
    const updatedIssue = makeIssue({ state: "InProgress" })
    const nextState = updateRunningIssueSnapshot(state, updatedIssue)
    expect(nextState.running.get(issue.id)!.issue.state).toBe("InProgress")
  })

  it("is a no-op when issue is not in running map", () => {
    const state = makeInitialState(5000, 10)
    const issue = makeIssue({ state: "InProgress" })
    const nextState = updateRunningIssueSnapshot(state, issue)
    expect(nextState.running.size).toBe(0)  // unchanged
  })
})

// ── Bullets 5 & 6 & 7: Reconciliation behaviour ───────────────────────────────

describe("reconciliation — §17.4 bullets 5, 6, 7", () => {
  it("empty running map: reconciliation is a no-op (fetchIssueStatesByIds not called)", async () => {
    let fetchCalled = false
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const config = makeConfig()
        const stateRef = yield* Ref.make(makeInitialState(5000, 10))
        const layers = makeMockLayers(config, stateRef, {
          onFetchIssueStatesByIds: () => { fetchCalled = true },
        })
        yield* Effect.provide(tick(), layers)
        return yield* Ref.get(stateRef)
      })
    )
    expect(result.running.size).toBe(0)
    expect(fetchCalled).toBe(false)
  })

  it("non-active state stops running agent WITHOUT workspace cleanup", async () => {
    let removeCalled = false
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const config = makeConfig()
        const issue = makeIssue({ state: "Todo" })
        // "Paused" is not in active_states and not in terminal_states
        const refreshedIssue = makeIssue({ state: "Paused" })
        const initialState = addRunning(
          makeInitialState(5000, 10),
          issue.id,
          makeRunningEntry(issue, "/ws", null, DUMMY_FIBER)
        )
        const stateRef = yield* Ref.make(initialState)
        const layers = makeMockLayers(config, stateRef, {
          refreshedIssues: [refreshedIssue],
          onRemoveForIssue: () => { removeCalled = true },
        })
        yield* Effect.provide(tick(), layers)
        return yield* Ref.get(stateRef)
      })
    )
    expect(result.running.has("issue-1")).toBe(false)  // entry removed
    expect(removeCalled).toBe(false)  // workspace NOT cleaned up
  })

  it("terminal state stops running agent AND cleans up workspace", async () => {
    let removedIdentifier: string | null = null
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const config = makeConfig()
        const issue = makeIssue({ state: "Todo" })
        // "Done" is in terminal_states
        const refreshedIssue = makeIssue({ state: "Done" })
        const initialState = addRunning(
          makeInitialState(5000, 10),
          issue.id,
          makeRunningEntry(issue, "/ws", null, DUMMY_FIBER)
        )
        const stateRef = yield* Ref.make(initialState)
        const layers = makeMockLayers(config, stateRef, {
          refreshedIssues: [refreshedIssue],
          onRemoveForIssue: (id) => { removedIdentifier = id },
        })
        yield* Effect.provide(tick(), layers)
        return yield* Ref.get(stateRef)
      })
    )
    expect(result.running.has("issue-1")).toBe(false)  // entry removed
    expect(removedIdentifier).toBe("ABC-1")  // workspace cleaned up
  })
})

// ── Bullets 8 & 9: Worker exit retry scheduling ───────────────────────────────

describe("handleWorkerExit — §17.4 bullets 8 & 9", () => {
  it("normal exit schedules continuation retry at attempt 1 with null error", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const config = makeConfig()
        const issue = makeIssue()
        const initialState = addRunning(
          makeInitialState(5000, 10),
          issue.id,
          makeRunningEntry(issue, "/ws", null, DUMMY_FIBER)
        )
        const stateRef = yield* Ref.make(initialState)
        const layers = makeMockLayers(config, stateRef)
        yield* Effect.provide(
          handleWorkerExit(issue.id, true),
          layers
        )
        return yield* Ref.get(stateRef)
      })
    )
    // Running entry removed
    expect(state.running.has("issue-1")).toBe(false)
    // Issue added to completed set
    expect(state.completed.has("issue-1")).toBe(true)
    // Retry scheduled at attempt 1 with no error (continuation)
    expect(state.retry_attempts.has("issue-1")).toBe(true)
    const retry = state.retry_attempts.get("issue-1")!
    expect(retry.attempt).toBe(1)
    expect(retry.error).toBeNull()
  })

  it("abnormal exit increments attempt and uses exponential backoff delay", async () => {
    const beforeMs = Date.now()
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const config = makeConfig()
        const issue = makeIssue()
        // retry_attempt = 2 → nextAttempt = 3
        const initialState = addRunning(
          makeInitialState(5000, 10),
          issue.id,
          makeRunningEntry(issue, "/ws", 2, DUMMY_FIBER)
        )
        const stateRef = yield* Ref.make(initialState)
        const layers = makeMockLayers(config, stateRef)
        yield* Effect.provide(
          handleWorkerExit(issue.id, false),
          layers
        )
        return yield* Ref.get(stateRef)
      })
    )
    expect(state.running.has("issue-1")).toBe(false)
    expect(state.completed.has("issue-1")).toBe(false)  // NOT added to completed
    expect(state.retry_attempts.has("issue-1")).toBe(true)
    const retry = state.retry_attempts.get("issue-1")!
    expect(retry.attempt).toBe(3)
    expect(retry.error).toBe("worker exited abnormally")
    // Delay for attempt 3 = 10000 * 2^2 = 40000ms
    const expectedDelay = 40_000
    expect(retry.due_at_ms).toBeGreaterThanOrEqual(beforeMs + expectedDelay - 100)
    expect(retry.due_at_ms).toBeLessThanOrEqual(beforeMs + expectedDelay + 5000)
  })

  it("abnormal exit with attempt=1 uses delay=10000ms (2^0 * 10000)", async () => {
    const beforeMs = Date.now()
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const config = makeConfig()
        const issue = makeIssue()
        // retry_attempt = 0 → nextAttemptFromRunning returns null → fallback to 1
        const initialState = addRunning(
          makeInitialState(5000, 10),
          issue.id,
          makeRunningEntry(issue, "/ws", null, DUMMY_FIBER)
        )
        const stateRef = yield* Ref.make(initialState)
        const layers = makeMockLayers(config, stateRef)
        yield* Effect.provide(
          handleWorkerExit(issue.id, false),
          layers
        )
        return yield* Ref.get(stateRef)
      })
    )
    const retry = state.retry_attempts.get("issue-1")!
    expect(retry.attempt).toBe(1)
    const expectedDelay = 10_000
    expect(retry.due_at_ms).toBeGreaterThanOrEqual(beforeMs + expectedDelay - 100)
    expect(retry.due_at_ms).toBeLessThanOrEqual(beforeMs + expectedDelay + 5000)
  })
})

// ── Bullet 10: Retry backoff cap ──────────────────────────────────────────────

describe("retryDelay — §17.4 bullets 10 & 15", () => {
  it("backoff formula: min(10000 * 2^(attempt-1), max_retry_backoff_ms) — attempt 1", () => {
    expect(retryDelay(1, false, 300_000)).toBe(10_000)   // 10000 * 2^0
  })

  it("backoff formula — attempt 2 = 20000ms", () => {
    expect(retryDelay(2, false, 300_000)).toBe(20_000)   // 10000 * 2^1
  })

  it("backoff formula — attempt 3 = 40000ms", () => {
    expect(retryDelay(3, false, 300_000)).toBe(40_000)   // 10000 * 2^2
  })

  it("backoff cap: very large attempt never exceeds max_retry_backoff_ms", () => {
    const maxMs = 300_000
    expect(retryDelay(100, false, maxMs)).toBe(maxMs)
  })

  it("custom lower cap is respected", () => {
    const capMs = 60_000
    expect(retryDelay(10, false, capMs)).toBe(capMs)   // 10000*2^9 = 5120000 > 60000
  })

  it("continuation retry at attempt 1 = 1000ms (short delay)", () => {
    expect(retryDelay(1, true, 300_000)).toBe(1_000)
  })
})

// ── Bullet 11: Retry queue entry shape ────────────────────────────────────────

describe("setRetryEntry — §17.4 bullet 11", () => {
  it("retry entry has attempt, due_at_ms, identifier, and error fields", () => {
    const state = makeInitialState(5000, 10)
    const dueMs = Date.now() + 10_000
    const entry = {
      issue_id: "issue-1",
      identifier: "ABC-1",
      attempt: 2,
      due_at_ms: dueMs,
      error: "stall timeout",
      timer_handle: null,
    }
    const nextState = setRetryEntry(state, "issue-1", entry)
    const stored = nextState.retry_attempts.get("issue-1")!
    expect(stored.attempt).toBe(2)
    expect(stored.due_at_ms).toBe(dueMs)
    expect(stored.identifier).toBe("ABC-1")
    expect(stored.error).toBe("stall timeout")
  })

  it("retry entry with null error is valid (continuation)", () => {
    const state = makeInitialState(5000, 10)
    const entry = {
      issue_id: "issue-1",
      identifier: "ABC-1",
      attempt: 1,
      due_at_ms: Date.now() + 1_000,
      error: null,
      timer_handle: null,
    }
    const nextState = setRetryEntry(state, "issue-1", entry)
    expect(nextState.retry_attempts.get("issue-1")!.error).toBeNull()
  })
})

// ── Bullet 12: Stall detection ────────────────────────────────────────────────

describe("stall detection — §17.4 bullet 12", () => {
  it("stalled session is removed from running and a retry is scheduled", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // stall_timeout_ms = 500ms; entry started 5 seconds ago → stalled
        const config = makeConfig({ codex: { stall_timeout_ms: 500 } })
        const issue = makeIssue()
        const oldStartedAt = new Date(Date.now() - 5_000)
        const runningEntry = {
          ...makeRunningEntry(issue, "/ws", null, DUMMY_FIBER),
          started_at: oldStartedAt,
        }
        const initialState = addRunning(
          makeInitialState(5000, 10),
          issue.id,
          runningEntry
        )
        const stateRef = yield* Ref.make(initialState)
        const layers = makeMockLayers(config, stateRef)
        yield* Effect.provide(tick(), layers)
        return yield* Ref.get(stateRef)
      })
    )
    expect(result.running.has("issue-1")).toBe(false)   // removed from running
    expect(result.retry_attempts.has("issue-1")).toBe(true)  // retry scheduled
    const retry = result.retry_attempts.get("issue-1")!
    expect(typeof retry.error).toBe("string")  // error message populated
    expect(retry.error).toMatch(/stalled/)
  })
})

// ── Bullet 13: Slot exhaustion ────────────────────────────────────────────────

describe("slot exhaustion — §17.4 bullet 13", () => {
  it("availableGlobalSlots returns 0 when all slots are occupied", () => {
    const state = addRunning(
      makeInitialState(5000, 1),  // max 1 agent
      "issue-1",
      makeRunningEntry(makeIssue(), "/ws", null, DUMMY_FIBER)
    )
    expect(availableGlobalSlots(state)).toBe(0)
  })

  it("isEligible returns false when no slots are available", () => {
    const config = makeConfig({ agent: { max_concurrent_agents: 1 } })
    const occupiedState = addRunning(
      makeInitialState(5000, 1),
      "issue-1",
      makeRunningEntry(makeIssue({ id: "issue-1", identifier: "ABC-1" }), "/ws", null, DUMMY_FIBER)
    )
    // A different issue that would otherwise be eligible
    const candidate = makeIssue({ id: "issue-2", identifier: "ABC-2" })
    expect(isEligible(candidate, occupiedState, config)).toBe(false)
  })

  it("tick does not dispatch new issues when running is full (slot exhaustion → requeue)", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const config = makeConfig({ agent: { max_concurrent_agents: 1 } })
        const runningIssue = makeIssue({ id: "issue-1", identifier: "ABC-1", state: "InProgress" })
        // A candidate that would otherwise be eligible
        const candidate = makeIssue({ id: "issue-2", identifier: "ABC-2", state: "Todo" })
        const refreshed = makeIssue({ id: "issue-1", identifier: "ABC-1", state: "InProgress" })
        const initialState = addRunning(
          makeInitialState(5000, 1),
          runningIssue.id,
          makeRunningEntry(runningIssue, "/ws", null, DUMMY_FIBER)
        )
        const stateRef = yield* Ref.make(initialState)
        const layers = makeMockLayers(config, stateRef, {
          candidateIssues: [candidate],
          refreshedIssues: [refreshed],
        })
        yield* Effect.provide(tick(), layers)
        return yield* Ref.get(stateRef)
      })
    )
    // Only 1 slot, already occupied: no new running entries added
    expect(result.running.size).toBe(1)
    expect(result.running.has("issue-1")).toBe(true)
    expect(result.running.has("issue-2")).toBe(false)
  })
})

// ── Bullets 14 & (snapshot timeout): buildSnapshot ───────────────────────────

describe("buildSnapshot — §17.4 bullet 14", () => {
  it("returns running rows, retry rows, token totals, and rate limits", () => {
    const issue = makeIssue()
    const runningEntry = makeRunningEntry(issue, "/ws", null, DUMMY_FIBER)
    const stateWithRunning = addRunning(
      makeInitialState(5000, 10),
      issue.id,
      runningEntry
    )
    const retryEntry = {
      issue_id: "issue-2",
      identifier: "XYZ-2",
      attempt: 3,
      due_at_ms: Date.now() + 30_000,
      error: "previous run failed",
      timer_handle: null,
    }
    const stateWithBoth = {
      ...setRetryEntry(stateWithRunning, "issue-2", retryEntry),
      codex_totals: {
        input_tokens: 100,
        output_tokens: 200,
        total_tokens: 300,
        seconds_running: 42,
      },
      codex_rate_limits: { limit: 50_000, remaining: 49_000 },
    }

    const snapshot = buildSnapshot(stateWithBoth)

    // Shape checks
    expect(typeof snapshot.generated_at).toBe("string")
    expect(snapshot.counts.running).toBe(1)
    expect(snapshot.counts.retrying).toBe(1)

    // Running row
    expect(snapshot.running).toHaveLength(1)
    const row = snapshot.running[0]!
    expect(row.issue_id).toBe("issue-1")
    expect(row.issue_identifier).toBe("ABC-1")
    expect(typeof row.started_at).toBe("string")  // ISO string
    expect(row.tokens).toMatchObject({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })

    // Retry row
    expect(snapshot.retrying).toHaveLength(1)
    const retryRow = snapshot.retrying[0]!
    expect(retryRow.issue_id).toBe("issue-2")
    expect(retryRow.attempt).toBe(3)
    expect(retryRow.error).toBe("previous run failed")
    expect(typeof retryRow.due_at).toBe("string")

    // Token totals
    expect(snapshot.codex_totals.input_tokens).toBe(100)
    expect(snapshot.codex_totals.output_tokens).toBe(200)
    expect(snapshot.codex_totals.total_tokens).toBe(300)

    // Rate limits
    expect(snapshot.rate_limits).toMatchObject({ limit: 50_000, remaining: 49_000 })
  })

  it("snapshot with no running or retrying has empty arrays and zero counts", () => {
    const snapshot = buildSnapshot(makeInitialState(5000, 10))
    expect(snapshot.running).toHaveLength(0)
    expect(snapshot.retrying).toHaveLength(0)
    expect(snapshot.counts.running).toBe(0)
    expect(snapshot.counts.retrying).toBe(0)
    expect(snapshot.rate_limits).toBeNull()
  })
})
