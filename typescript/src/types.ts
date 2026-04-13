// Symphony Domain Types
// Based on SPEC.md §4 — Core Domain Model

import { Data } from "effect"
import type { Fiber } from "effect"

// ─── Issue ────────────────────────────────────────────────────────────────────

export interface BlockerRef {
  readonly id: string | null
  readonly identifier: string | null
  readonly state: string | null
}

export interface Issue {
  readonly id: string
  readonly identifier: string
  readonly title: string
  readonly description: string | null
  readonly priority: number | null
  readonly state: string
  readonly branch_name: string | null
  readonly url: string | null
  readonly assignee_id: string | null
  readonly labels: ReadonlyArray<string>
  readonly blocked_by: ReadonlyArray<BlockerRef>
  readonly created_at: Date | null
  readonly updated_at: Date | null
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

export interface TrackerConfig {
  readonly kind?: "linear" | "plane" | string
  readonly endpoint?: string
  readonly api_key?: string
  readonly project_slug?: string
  readonly workspace_slug?: string
  readonly project_id?: string
  readonly active_states?: ReadonlyArray<string>
  readonly terminal_states?: ReadonlyArray<string>
  readonly assignee?: string
}

export interface PollingConfig {
  readonly interval_ms?: number | string
}

export interface WorkspaceConfig {
  readonly root?: string
}

export interface HooksConfig {
  readonly after_create?: string | null
  readonly before_run?: string | null
  readonly after_run?: string | null
  readonly before_remove?: string | null
  readonly timeout_ms?: number | string
}

export interface AgentConfig {
  readonly max_concurrent_agents?: number | string
  readonly max_turns?: number | string
  readonly max_retry_backoff_ms?: number | string
  readonly max_concurrent_agents_by_state?: Record<string, number>
  readonly engine?: "codex" | "opencode"
}

export interface CodexConfig {
  readonly command?: string
  readonly approval_policy?: unknown
  readonly thread_sandbox?: string
  readonly turn_sandbox_policy?: unknown
  readonly turn_timeout_ms?: number
  readonly read_timeout_ms?: number
  readonly stall_timeout_ms?: number
}

export interface OpenCodeConfig {
  readonly mode?: "per-workspace" | "shared"
  readonly server_url?: string | null
  readonly model?: string
  readonly agent?: string
  readonly port?: number
}

export interface ServerConfig {
  readonly port?: number
  readonly host?: string
}

export interface WorkflowConfig {
  readonly tracker?: TrackerConfig
  readonly polling?: PollingConfig
  readonly workspace?: WorkspaceConfig
  readonly hooks?: HooksConfig
  readonly agent?: AgentConfig
  readonly codex?: CodexConfig
  readonly opencode?: OpenCodeConfig
  readonly server?: ServerConfig
}

export interface WorkflowDefinition {
  readonly config: WorkflowConfig
  readonly prompt_template: string
}

// ─── Resolved / Typed Config ──────────────────────────────────────────────────

/** Fully resolved config with all defaults applied and $VAR expanded */
export interface ResolvedConfig {
  readonly tracker: {
    readonly kind: "linear" | "plane" | ""
    readonly endpoint: string
    readonly api_key: string
    readonly project_slug: string
    readonly workspace_slug?: string
    readonly project_id?: string
    readonly active_states: ReadonlyArray<string>
    readonly terminal_states: ReadonlyArray<string>
    readonly assignee: string | null
  }
  readonly polling: {
    readonly interval_ms: number
  }
  readonly workspace: {
    readonly root: string
  }
  readonly hooks: {
    readonly after_create: string | null
    readonly before_run: string | null
    readonly after_run: string | null
    readonly before_remove: string | null
    readonly timeout_ms: number
  }
  readonly agent: {
    readonly max_concurrent_agents: number
    readonly max_turns: number
    readonly max_retry_backoff_ms: number
    readonly max_concurrent_agents_by_state: Record<string, number>
    readonly engine: "codex" | "opencode"
  }
  readonly codex: {
    readonly command: string
    readonly approval_policy: unknown
    readonly thread_sandbox: string
    readonly turn_sandbox_policy: unknown
    readonly turn_timeout_ms: number
    readonly read_timeout_ms: number
    readonly stall_timeout_ms: number
  }
  readonly opencode: {
    readonly mode: "per-workspace" | "shared"
    readonly server_url: string | null
    readonly model: string
    readonly agent: string
    readonly port: number
  }
  readonly server: {
    readonly port: number | null
    readonly host: string
  }
}

// ─── Workspace ────────────────────────────────────────────────────────────────

export interface Workspace {
  readonly path: string
  readonly workspace_key: string
  readonly created_now: boolean
}

// ─── Run Attempt ──────────────────────────────────────────────────────────────

export type RunAttemptStatus =
  | "PreparingWorkspace"
  | "BuildingPrompt"
  | "LaunchingAgentProcess"
  | "InitializingSession"
  | "StreamingTurn"
  | "Finishing"
  | "Succeeded"
  | "Failed"
  | "TimedOut"
  | "Stalled"
  | "CanceledByReconciliation"

// ─── Agent Events ─────────────────────────────────────────────────────────────

export interface TokenUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly total_tokens: number
}

export type AgentEvent =
  | { readonly type: "session_started"; readonly sessionId: string; readonly pid?: string }
  | { readonly type: "turn_completed"; readonly usage?: TokenUsage }
  | { readonly type: "turn_failed"; readonly error: string }
  | { readonly type: "turn_cancelled" }
  | { readonly type: "notification"; readonly message: string }
  | { readonly type: "approval_auto_approved"; readonly description: string }
  | { readonly type: "token_usage"; readonly input: number; readonly output: number; readonly total: number }
  | { readonly type: "rate_limit"; readonly payload: unknown }
  | { readonly type: "stall_heartbeat" }
  | { readonly type: "other"; readonly raw: unknown }

// ─── Orchestrator State ───────────────────────────────────────────────────────

export interface TokenTotals {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly total_tokens: number
  readonly seconds_running: number
}

export interface RecentAgentEvent {
  readonly at: Date
  readonly type: AgentEvent["type"]
  readonly summary: string
}

export interface RunningEntry {
  readonly issue_id: string
  readonly identifier: string
  readonly issue: Issue
  readonly session_id: string | null
  readonly thread_id: string | null
  readonly turn_id: string | null
  readonly codex_app_server_pid: string | null
  readonly last_codex_event: string | null
  readonly last_codex_timestamp: Date | null
  readonly last_codex_message: string | null
  readonly codex_input_tokens: number
  readonly codex_output_tokens: number
  readonly codex_total_tokens: number
  readonly last_reported_input_tokens: number
  readonly last_reported_output_tokens: number
  readonly last_reported_total_tokens: number
  readonly turn_count: number
  readonly retry_attempt: number | null
  readonly started_at: Date
  readonly workspace_path: string | null
  readonly recent_agent_events: ReadonlyArray<RecentAgentEvent>
  // Worker fiber handle
  readonly worker_fiber: Fiber.Fiber<void, unknown> | null
}

export interface RetryEntry {
  readonly issue_id: string
  readonly identifier: string
  readonly attempt: number
   readonly due_at_ms: number
   readonly error: string | null
   // Timer handle
   readonly timer_handle: Fiber.Fiber<void, never> | null
}

export interface OrchestratorState {
  readonly poll_interval_ms: number
  readonly max_concurrent_agents: number
  readonly running: ReadonlyMap<string, RunningEntry>
  readonly claimed: ReadonlySet<string>
  readonly retry_attempts: ReadonlyMap<string, RetryEntry>
  readonly completed: ReadonlySet<string>
  readonly codex_totals: TokenTotals
  readonly codex_rate_limits: unknown | null
}

export interface RecentAgentEventRow {
  readonly at: string
  readonly type: AgentEvent["type"]
  readonly summary: string
}

export interface RunningRow {
  readonly issue_id: string
  readonly issue_identifier: string
  readonly state: string
  readonly session_id: string | null
  readonly turn_count: number
  readonly last_event: string | null
  readonly last_message: string | null
  readonly started_at: string
  readonly last_event_at: string | null
  readonly tokens: {
    readonly input_tokens: number
    readonly output_tokens: number
    readonly total_tokens: number
  }
  readonly recent_events: ReadonlyArray<RecentAgentEventRow>
}

export interface RetryRow {
  readonly issue_id: string
  readonly issue_identifier: string
  readonly attempt: number
  readonly due_at: string
  readonly error: string | null
}

export interface RuntimeSnapshot {
  readonly generated_at: string
  readonly counts: {
    readonly running: number
    readonly retrying: number
  }
  readonly running: ReadonlyArray<RunningRow>
  readonly retrying: ReadonlyArray<RetryRow>
  readonly codex_totals: {
    readonly input_tokens: number
    readonly output_tokens: number
    readonly total_tokens: number
    readonly seconds_running: number
  }
  readonly rate_limits: unknown | null
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export type WorkflowErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "template_parse_error"
  | "template_render_error"

export class WorkflowError extends Data.TaggedError("WorkflowError")<{
  readonly code: WorkflowErrorCode
  readonly message: string
  readonly cause?: unknown
}> {}

export type ConfigErrorCode =
  | "unsupported_tracker_kind"
  | "missing_tracker_api_key"
  | "missing_tracker_project_slug"
  | "missing_tracker_workspace_slug"
  | "missing_tracker_project_id"
  | "missing_codex_command"
  | "invalid_config"

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly code: ConfigErrorCode
  readonly message: string
}> {}

export type TrackerErrorCode =
  | "unsupported_tracker_kind"
  | "missing_tracker_api_key"
  | "missing_tracker_project_slug"
  | "missing_tracker_workspace_slug"
  | "missing_tracker_project_id"
  | "linear_api_request"
  | "linear_api_status"
  | "linear_graphql_errors"
  | "linear_unknown_payload"
  | "linear_missing_end_cursor"
  | "plane_api_request"
  | "plane_api_status"
  | "plane_unknown_payload"
  | "plane_missing_next_cursor"

export class TrackerError extends Data.TaggedError("TrackerError")<{
  readonly code: TrackerErrorCode
  readonly message: string
  readonly cause?: unknown
}> {}

export type WorkspaceErrorCode =
  | "path_containment_violation"
  | "workspace_creation_failed"
  | "hook_failed"
  | "hook_timeout"
  | "invalid_workspace_key"

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly code: WorkspaceErrorCode
  readonly message: string
  readonly cause?: unknown
}> {}

export type AgentErrorCode =
  | "codex_not_found"
  | "invalid_workspace_cwd"
  | "response_timeout"
  | "turn_timeout"
  | "port_exit"
  | "response_error"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_input_required"
  | "session_startup_failed"

export class AgentError extends Data.TaggedError("AgentError")<{
  readonly code: AgentErrorCode
  readonly message: string
  readonly cause?: unknown
}> {}

export type PromptErrorCode =
  | "template_parse_error"
  | "template_render_error"

export class PromptError extends Data.TaggedError("PromptError")<{
  readonly code: PromptErrorCode
  readonly message: string
  readonly cause?: unknown
}> {}

export type SymphonyError =
  | WorkflowError
  | ConfigError
  | TrackerError
  | WorkspaceError
  | AgentError
  | PromptError
