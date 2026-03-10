import { Effect, Ref, Stream, Cause } from "effect"
import type { Issue, AgentEvent } from "../types.js"
import { updateRunningEntry, addTokenDelta, setRateLimits, isActiveState } from "./state.js"
import { WorkspaceManager, TrackerClient, WorkflowStore, PromptEngine, OrchestratorStateRef } from "../services.js"
import { AgentEngine } from "../engine/agent.js"
import type { AgentSession } from "../engine/agent.js"

export function runWorker(
  issue: Issue,
  attempt: number | null
): Effect.Effect<
  void,
  unknown,
  WorkspaceManager | TrackerClient | WorkflowStore | PromptEngine | AgentEngine | OrchestratorStateRef
> {
  return Effect.gen(function* () {
    const { ref: stateRef } = yield* OrchestratorStateRef
    const store = yield* WorkflowStore
    const config = yield* store.getResolved()
    const workspaceManager = yield* WorkspaceManager
    const agentEngine = yield* AgentEngine

    const workspace = yield* workspaceManager.createForIssue(issue.identifier)

    yield* Ref.update(stateRef, (s) =>
      updateRunningEntry(s, issue.id, (e) => ({ ...e, workspace_path: workspace.path }))
    )

    if (config.hooks.before_run) {
      yield* Effect.catch(
        workspaceManager.runHook("before_run", workspace.path),
        (error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(`before_run hook failed for ${issue.identifier}`)
            return yield* Effect.fail(error)
          })
      )
    }

    const session: AgentSession = yield* Effect.catch(
      agentEngine.createSession({
        workspace: workspace.path,
        cwd: workspace.path,
        config,
      }),
      (error) =>
        Effect.gen(function* () {
          yield* bestEffortAfterRun(workspace.path)
          return yield* Effect.fail(error)
        })
    )

    yield* Ref.update(stateRef, (s) =>
      updateRunningEntry(s, issue.id, (e) => ({
        ...e,
        session_id: session.sessionId,
        thread_id: session.threadId,
      }))
    )

     yield* Effect.catch(
       turnsLoop(issue, attempt, session),
       (error) =>
         Effect.gen(function* () {
           yield* Effect.catchCauseIf(
             session.dispose(),
             (cause) => !Cause.hasInterruptsOnly(cause),
             (cause) => Effect.logDebug("session dispose failed (error path)").pipe(Effect.annotateLogs("cause", Cause.pretty(cause)))
           )
           yield* bestEffortAfterRun(workspace.path)
           return yield* Effect.fail(error)
         })
     )

    yield* Effect.catchCauseIf(
      session.dispose(),
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logDebug("session dispose failed").pipe(Effect.annotateLogs("cause", Cause.pretty(cause)))
    )
    yield* bestEffortAfterRun(workspace.path)
  })
}

function bestEffortAfterRun(
  workspacePath: string
): Effect.Effect<void, never, WorkspaceManager> {
  return Effect.gen(function* () {
    const workspaceManager = yield* WorkspaceManager
    yield* Effect.catch(
      workspaceManager.runHook("after_run", workspacePath),
      (error) => Effect.logDebug("after_run hook failed (best-effort)").pipe(Effect.annotateLogs("cause", error.message))
    )
  })
}

function turnsLoop(
  issue: Issue,
  attempt: number | null,
  session: AgentSession
): Effect.Effect<void, unknown, OrchestratorStateRef | WorkflowStore | TrackerClient | PromptEngine> {
  return Effect.gen(function* () {
    const { ref: stateRef } = yield* OrchestratorStateRef
    const store = yield* WorkflowStore
    const config = yield* store.getResolved()
    const tracker = yield* TrackerClient
    const promptEngine = yield* PromptEngine

    const maxTurns = config.agent.max_turns
    let currentIssue = issue
    let turnNumber = 1

    while (true) {
      const workflow = yield* store.get()
      const isContinuation = turnNumber > 1
      const prompt = yield* promptEngine.render(
        isContinuation
          ? `Continuation guidance:\n\n- The previous Codex turn completed normally, but the Linear issue is still in an active state.\n- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.\n- Resume from the current workspace state instead of restarting from scratch.\n- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.\n- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.`
          : workflow.prompt_template,
        currentIssue,
        attempt
      )

      yield* Ref.update(stateRef, (s) =>
        updateRunningEntry(s, currentIssue.id, (e) => ({
          ...e,
          turn_count: turnNumber,
        }))
      )

      const turnStream = session.runTurn({
        prompt,
        title: currentIssue.title,
        continuation: isContinuation,
      })

      yield* Stream.runForEach(turnStream, (event: AgentEvent) =>
        handleAgentEvent(currentIssue.id, event)
      )

      const refreshedIssues = yield* tracker.fetchIssueStatesByIds([currentIssue.id])
      const refreshedIssue = refreshedIssues.find((i: Issue) => i.id === currentIssue.id)
      if (refreshedIssue) {
        currentIssue = refreshedIssue
      }

      if (!isActiveState(currentIssue.state, config.tracker.active_states)) break
      if (turnNumber >= maxTurns) break

      turnNumber++
    }
  })
}

function handleAgentEvent(
  issueId: string,
  event: AgentEvent
): Effect.Effect<void, never, OrchestratorStateRef> {
  return Effect.gen(function* () {
    const { ref: stateRef } = yield* OrchestratorStateRef
    const now = new Date()

    switch (event.type) {
      case "session_started":
        yield* Ref.update(stateRef, (s) =>
          updateRunningEntry(s, issueId, (e) => ({
            ...e,
            session_id: event.sessionId,
            codex_app_server_pid: event.pid ?? null,
            last_codex_event: "session_started",
            last_codex_timestamp: now,
          }))
        )
        break

      case "token_usage":
        yield* Ref.update(stateRef, (s) => {
          const entry = s.running.get(issueId)
          if (!entry) return s

          const inputDelta = Math.max(0, event.input - entry.last_reported_input_tokens)
          const outputDelta = Math.max(0, event.output - entry.last_reported_output_tokens)
          const totalDelta = Math.max(0, event.total - entry.last_reported_total_tokens)

          const updated = updateRunningEntry(s, issueId, (e) => ({
            ...e,
            codex_input_tokens: e.codex_input_tokens + inputDelta,
            codex_output_tokens: e.codex_output_tokens + outputDelta,
            codex_total_tokens: e.codex_total_tokens + totalDelta,
            last_reported_input_tokens: Math.max(e.last_reported_input_tokens, event.input),
            last_reported_output_tokens: Math.max(e.last_reported_output_tokens, event.output),
            last_reported_total_tokens: Math.max(e.last_reported_total_tokens, event.total),
            last_codex_event: "token_usage",
            last_codex_timestamp: now,
          }))

          return addTokenDelta(updated, inputDelta, outputDelta, totalDelta)
        })
        break

      case "rate_limit":
        yield* Ref.update(stateRef, (s) =>
          setRateLimits(
            updateRunningEntry(s, issueId, (e) => ({
              ...e,
              last_codex_event: "rate_limit",
              last_codex_timestamp: now,
            })),
            event.payload
          )
        )
        break

      case "turn_completed":
        yield* Ref.update(stateRef, (s) =>
          updateRunningEntry(s, issueId, (e) => ({
            ...e,
            last_codex_event: "turn_completed",
            last_codex_timestamp: now,
          }))
        )
        break

      case "notification":
        yield* Ref.update(stateRef, (s) =>
          updateRunningEntry(s, issueId, (e) => ({
            ...e,
            last_codex_message: event.message,
            last_codex_event: "notification",
            last_codex_timestamp: now,
          }))
        )
        break

      default:
        yield* Ref.update(stateRef, (s) =>
          updateRunningEntry(s, issueId, (e) => ({
            ...e,
            last_codex_event: event.type,
            last_codex_timestamp: now,
          }))
        )
        break
    }
  })
}
