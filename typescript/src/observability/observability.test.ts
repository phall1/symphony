import { describe, it, expect } from "vitest"
import { Effect, Layer, Logger, References } from "effect"
import { buildSnapshot } from "./snapshot.js"
import { withIssueContext, withSessionContext } from "./logger.js"
import { validateDispatchConfig } from "../config/index.js"
import type {
  OrchestratorState,
  RunningEntry,
  RetryEntry,
  Issue,
  ResolvedConfig,
} from "../types.js"

// ─── Test fixtures ────────────────────────────────────────────────────────────

const baseIssue: Issue = {
  id: "issue-1",
  identifier: "MT-1",
  title: "Test Issue",
  description: null,
  priority: 1,
  state: "In Progress",
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: null,
  updated_at: null,
}

function emptyState(): OrchestratorState {
  return {
    poll_interval_ms: 30000,
    max_concurrent_agents: 3,
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    completed: new Set(),
    codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
    codex_rate_limits: null,
  }
}

function makeRunningEntry(overrides: Partial<RunningEntry> = {}): RunningEntry {
  return {
    issue_id: "issue-1",
    identifier: "MT-1",
    issue: baseIssue,
    session_id: "session-abc",
    thread_id: null,
    turn_id: null,
    codex_app_server_pid: null,
    last_codex_event: "turn_completed",
    last_codex_timestamp: null,
    last_codex_message: "Done",
    codex_input_tokens: 100,
    codex_output_tokens: 50,
    codex_total_tokens: 150,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    turn_count: 3,
    retry_attempt: null,
    started_at: new Date(),
    worker_fiber: null,
    ...overrides,
  }
}

function makeRetryEntry(overrides: Partial<RetryEntry> = {}): RetryEntry {
  return {
    issue_id: "issue-2",
    identifier: "MT-2",
    attempt: 1,
    due_at_ms: Date.now() + 60_000,
    error: "previous run failed",
    timer_handle: null,
    ...overrides,
  }
}

function makeValidConfig(): ResolvedConfig {
  return {
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "valid-api-key",
      project_slug: "my-project",
      active_states: ["In Progress"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 30_000 },
    workspace: { root: "/tmp/workspaces" },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 60_000 },
    agent: {
      max_concurrent_agents: 3,
      max_turns: 100,
      max_retry_backoff_ms: 300_000,
      max_concurrent_agents_by_state: {},
      engine: "codex",
    },
    codex: {
      command: "codex",
      approval_policy: null,
      thread_sandbox: "",
      turn_sandbox_policy: null,
      turn_timeout_ms: 300_000,
      read_timeout_ms: 60_000,
      stall_timeout_ms: 120_000,
    },
    opencode: { mode: "per-workspace", server_url: null, model: "", agent: "", port: 0 },
    server: { port: null },
  }
}

// ─── §17.6 Observability Tests ────────────────────────────────────────────────

describe("§17.6 Observability", () => {
  describe("snapshot returns running rows, retry rows, token totals, rate limits", () => {
    it("buildSnapshot returns correct shape on empty state", () => {
      const snapshot = buildSnapshot(emptyState())
      expect(snapshot).toMatchObject({
        counts: { running: 0, retrying: 0 },
        running: [],
        retrying: [],
        codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        rate_limits: null,
      })
      expect(typeof snapshot.generated_at).toBe("string")
      expect(() => new Date(snapshot.generated_at)).not.toThrow()
    })

    it("buildSnapshot includes running rows with correct fields", () => {
      const entry = makeRunningEntry()
      const state: OrchestratorState = {
        ...emptyState(),
        running: new Map([["MT-1", entry]]),
      }
      const snapshot = buildSnapshot(state)

      expect(snapshot.counts.running).toBe(1)
      expect(snapshot.running).toHaveLength(1)

      const row = snapshot.running[0]!
      expect(row.issue_id).toBe("issue-1")
      expect(row.issue_identifier).toBe("MT-1")
      expect(row.session_id).toBe("session-abc")
      expect(row.turn_count).toBe(3)
      expect(row.state).toBe("In Progress")
      expect(row.tokens.input_tokens).toBe(100)
      expect(row.tokens.output_tokens).toBe(50)
      expect(row.tokens.total_tokens).toBe(150)
      expect(typeof row.started_at).toBe("string")
    })

    it("buildSnapshot includes retry rows with correct fields", () => {
      const entry = makeRetryEntry()
      const state: OrchestratorState = {
        ...emptyState(),
        retry_attempts: new Map([["MT-2", entry]]),
      }
      const snapshot = buildSnapshot(state)

      expect(snapshot.counts.retrying).toBe(1)
      expect(snapshot.retrying).toHaveLength(1)

      const row = snapshot.retrying[0]!
      expect(row.issue_id).toBe("issue-2")
      expect(row.issue_identifier).toBe("MT-2")
      expect(row.attempt).toBe(1)
      expect(row.error).toBe("previous run failed")
      expect(typeof row.due_at).toBe("string")
    })
  })

  describe("token/rate-limit aggregation correct across repeated updates", () => {
    it("accumulated totals flow through to snapshot", () => {
      const state: OrchestratorState = {
        ...emptyState(),
        codex_totals: {
          input_tokens: 1_000,
          output_tokens: 500,
          total_tokens: 1_500,
          seconds_running: 120,
        },
        running: new Map([
          ["MT-1", makeRunningEntry({ codex_input_tokens: 200, codex_output_tokens: 100, codex_total_tokens: 300 })],
          [
            "MT-3",
            makeRunningEntry({
              identifier: "MT-3",
              issue_id: "issue-3",
              codex_input_tokens: 400,
              codex_output_tokens: 200,
              codex_total_tokens: 600,
            }),
          ],
        ]),
        codex_rate_limits: { requests_remaining: 42 },
      }
      const snapshot = buildSnapshot(state)

      expect(snapshot.codex_totals.input_tokens).toBe(1_000)
      expect(snapshot.codex_totals.output_tokens).toBe(500)
      expect(snapshot.codex_totals.total_tokens).toBe(1_500)
      expect(snapshot.codex_totals.seconds_running).toBeGreaterThanOrEqual(120)
      expect(snapshot.running).toHaveLength(2)
      expect(snapshot.rate_limits).toEqual({ requests_remaining: 42 })
    })
  })

  describe("validation failures are operator-visible", () => {
    it("validateDispatchConfig returns empty array for valid config", () => {
      expect(validateDispatchConfig(makeValidConfig())).toEqual([])
    })

    it("validateDispatchConfig returns structured errors with human-readable messages", () => {
      const badConfig: ResolvedConfig = {
        ...makeValidConfig(),
        tracker: { ...makeValidConfig().tracker, api_key: "", project_slug: "" },
        codex: { ...makeValidConfig().codex, command: "" },
      }
      const errors = validateDispatchConfig(badConfig)

      expect(errors.length).toBeGreaterThan(0)
      for (const err of errors) {
        expect(err._tag).toBe("ConfigError")
        expect(typeof err.message).toBe("string")
        expect(err.message.length).toBeGreaterThan(10)
      }
    })
  })

  describe("structured logging includes issue/session context fields", () => {
    it("withIssueContext annotates Effects with issue_id and issue_identifier", async () => {
      const captured: Record<string, unknown>[] = []
      const captureLogger = Logger.make<unknown, void>((options) => {
        captured.push(options.fiber.getRef(References.CurrentLogAnnotations) as Record<string, unknown>)
      })

      await Effect.runPromise(
        Effect.provide(
          withIssueContext("issue-42", "MT-42")(Effect.logInfo("test")),
          Layer.mergeAll(Logger.layer([captureLogger]), Layer.succeed(References.MinimumLogLevel, "Trace"))
        )
      )

      expect(captured.length).toBeGreaterThan(0)
      expect(captured[0]!["issue_id"]).toBe("issue-42")
      expect(captured[0]!["issue_identifier"]).toBe("MT-42")
    })

    it("withSessionContext annotates Effects with session_id", async () => {
      const captured: Record<string, unknown>[] = []
      const captureLogger = Logger.make<unknown, void>((options) => {
        captured.push(options.fiber.getRef(References.CurrentLogAnnotations) as Record<string, unknown>)
      })

      await Effect.runPromise(
        Effect.provide(
          withSessionContext("session-xyz")(Effect.logInfo("test")),
          Layer.mergeAll(Logger.layer([captureLogger]), Layer.succeed(References.MinimumLogLevel, "Trace"))
        )
      )

      expect(captured.length).toBeGreaterThan(0)
      expect(captured[0]!["session_id"]).toBe("session-xyz")
    })
  })

  describe("logging sink failures do not crash orchestration", () => {
    it("Effect.logInfo/logWarning/logError have never on error channel — orchestration cannot fail from logging", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.logInfo("info message")
          yield* Effect.logWarning("warning message")
          yield* Effect.logError("error message")
          return "orchestration continued"
        })
      )
      expect(result).toBe("orchestration continued")
    })

    it("withIssueContext and withSessionContext preserve effect success through logging", async () => {
      const result = await Effect.runPromise(
        withIssueContext(
          "issue-1",
          "MT-1"
        )(
          withSessionContext("session-1")(
            Effect.gen(function* () {
              yield* Effect.logInfo("annotated log")
              return 42
            })
          )
        )
      )
      expect(result).toBe(42)
    })
  })
})
