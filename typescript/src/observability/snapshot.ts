import type {
  OrchestratorState,
  RuntimeSnapshot,
  RunningRow,
  RetryRow,
} from "../types.js"

// ─── buildSnapshot ─────────────────────────────────────────────────────────────
// seconds_running = ended-session cumulative + active-session elapsed (§13.5)

export function buildSnapshot(state: OrchestratorState): RuntimeSnapshot {
  const now = new Date()
  const generated_at = now.toISOString()

  let activeElapsedSeconds = 0
  const running: RunningRow[] = []

  for (const entry of state.running.values()) {
    activeElapsedSeconds += (now.getTime() - entry.started_at.getTime()) / 1000

    running.push({
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      state: entry.issue.state,
      session_id: entry.session_id,
      turn_count: entry.turn_count,
      last_event: entry.last_codex_event,
      last_message: entry.last_codex_message,
      started_at: entry.started_at.toISOString(),
      last_event_at:
        entry.last_codex_timestamp !== null
          ? entry.last_codex_timestamp.toISOString()
          : null,
      tokens: {
        input_tokens: entry.codex_input_tokens,
        output_tokens: entry.codex_output_tokens,
        total_tokens: entry.codex_total_tokens,
      },
      recent_events: entry.recent_agent_events.map((event) => ({
        at: event.at.toISOString(),
        type: event.type,
        summary: event.summary,
      })),
    })
  }

  const retrying: RetryRow[] = []
  for (const entry of state.retry_attempts.values()) {
    retrying.push({
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      attempt: entry.attempt,
      due_at: new Date(entry.due_at_ms).toISOString(),
      error: entry.error,
    })
  }

  const codex_totals = {
    input_tokens: state.codex_totals.input_tokens,
    output_tokens: state.codex_totals.output_tokens,
    total_tokens: state.codex_totals.total_tokens,
    seconds_running: state.codex_totals.seconds_running + activeElapsedSeconds,
  }

  return {
    generated_at,
    counts: {
      running: running.length,
      retrying: retrying.length,
    },
    running,
    retrying,
    codex_totals,
    rate_limits: state.codex_rate_limits,
  }
}
