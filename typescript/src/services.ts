import { ServiceMap, Ref } from "effect"
import type { Effect } from "effect"
import type {
  WorkflowDefinition,
  ResolvedConfig,
  Issue,
  Workspace,
  OrchestratorState,
  WorkflowError,
  ConfigError,
  TrackerError,
  WorkspaceError,
  PromptError,
} from "./types.js"

// ─── WorkflowStore ────────────────────────────────────────────────────────────

export class WorkflowStore extends ServiceMap.Service<
  WorkflowStore,
  {
    get(): Effect.Effect<WorkflowDefinition, WorkflowError>
    getResolved(): Effect.Effect<ResolvedConfig, ConfigError>
  }
>()(
  "WorkflowStore"
) {}

// ─── TrackerClient ────────────────────────────────────────────────────────────

export class TrackerClient extends ServiceMap.Service<
  TrackerClient,
  {
    fetchCandidateIssues(): Effect.Effect<ReadonlyArray<Issue>, TrackerError>
    fetchIssueStatesByIds(
      ids: ReadonlyArray<string>
    ): Effect.Effect<ReadonlyArray<Issue>, TrackerError>
    fetchIssuesByStates(
      states: ReadonlyArray<string>
    ): Effect.Effect<ReadonlyArray<Issue>, TrackerError>
  }
>()(
  "TrackerClient"
) {}

// ─── WorkspaceManager ─────────────────────────────────────────────────────────

export class WorkspaceManager extends ServiceMap.Service<
  WorkspaceManager,
  {
    createForIssue(
      identifier: string
    ): Effect.Effect<Workspace, WorkspaceError>
    removeForIssue(identifier: string): Effect.Effect<void, WorkspaceError>
    runHook(
      hook: "after_run" | "before_remove",
      workspacePath: string
    ): Effect.Effect<void, never>
  }
>()(
  "WorkspaceManager"
) {}

// ─── PromptEngine ────────────────────────────────────────────────────────────

export class PromptEngine extends ServiceMap.Service<
  PromptEngine,
  {
    render(
      template: string,
      issue: Issue,
      attempt: number | null
    ): Effect.Effect<string, PromptError>
  }
>()(
  "PromptEngine"
) {}

// ─── OrchestratorStateRef ─────────────────────────────────────────────────────

export class OrchestratorStateRef extends ServiceMap.Service<
  OrchestratorStateRef,
  {
    readonly ref: Ref.Ref<OrchestratorState>
  }
>()(
  "OrchestratorStateRef"
) {}
