import { Effect, Queue, Ref, Scope } from "effect"
import { Hono } from "hono"
import type { OrchestratorState } from "../types.js"
import { buildSnapshot } from "./snapshot.js"

// ─── Hono app factory ─────────────────────────────────────────────────────────

function makeApp(stateRef: Ref.Ref<OrchestratorState>, pollTrigger: Queue.Queue<void>): Hono {
  const app = new Hono()

  app.get("/", async (c) => {
    const state = await Effect.runPromise(Ref.get(stateRef))
    const snap = buildSnapshot(state)
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Symphony</title>
<meta http-equiv="refresh" content="10">
<style>body{font-family:monospace;max-width:900px;margin:40px auto;padding:0 20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}th{background:#f0f0f0}</style>
</head>
<body>
<h1>Symphony</h1>
<p>Running: <strong>${snap.counts.running}</strong> &nbsp; Retrying: <strong>${snap.counts.retrying}</strong> &nbsp; Generated: ${snap.generated_at}</p>
<h2>Active Sessions</h2>
${snap.running.length === 0 ? '<p>None</p>' : `<table><tr><th>Issue</th><th>State</th><th>Session</th><th>Turns</th><th>Last Event</th><th>Tokens</th></tr>
${snap.running.map(r => `<tr><td>${r.issue_identifier}</td><td>${r.state}</td><td>${r.session_id ?? ''}</td><td>${r.turn_count}</td><td>${r.last_event ?? ''}</td><td>${r.tokens.total_tokens}</td></tr>`).join('')}
</table>`}
<h2>Retry Queue</h2>
${snap.retrying.length === 0 ? '<p>None</p>' : `<table><tr><th>Issue</th><th>Attempt</th><th>Due At</th><th>Error</th></tr>
${snap.retrying.map(r => `<tr><td>${r.issue_identifier}</td><td>${r.attempt}</td><td>${r.due_at}</td><td>${r.error ?? ''}</td></tr>`).join('')}
</table>`}
<h2>Totals</h2>
<p>Input tokens: ${snap.codex_totals.input_tokens} &nbsp; Output: ${snap.codex_totals.output_tokens} &nbsp; Total: ${snap.codex_totals.total_tokens} &nbsp; Runtime: ${Math.round(snap.codex_totals.seconds_running)}s</p>
</body></html>`
    return c.html(html)
  })

  app.get("/api/v1/state", async (c) => {
    const state = await Effect.runPromise(Ref.get(stateRef))
    const snapshot = buildSnapshot(state)
    return c.json(snapshot)
  })

  app.get("/api/v1/:identifier", async (c) => {
    const identifier = c.req.param("identifier")
    const state = await Effect.runPromise(Ref.get(stateRef))

    const runningEntry = Array.from(state.running.values()).find(
      (e) => e.identifier === identifier
    )
    const retryEntry = state.retry_attempts.get(identifier)

    if (runningEntry === undefined && retryEntry === undefined) {
      return c.json(
        {
          error: {
            code: "issue_not_found",
            message: `Issue '${identifier}' not found in current runtime state`,
          },
        },
        404
      )
    }

    const now = new Date()

    return c.json({
      issue_identifier: identifier,
      issue_id: runningEntry?.issue_id ?? retryEntry?.issue_id ?? null,
      status: runningEntry !== undefined ? "running" : "retrying",
      workspace_path: runningEntry?.workspace_path ?? null,
      running:
        runningEntry !== undefined
          ? {
              session_id: runningEntry.session_id,
              turn_count: runningEntry.turn_count,
              state: runningEntry.issue.state,
              started_at: runningEntry.started_at.toISOString(),
              last_event: runningEntry.last_codex_event,
              last_message: runningEntry.last_codex_message,
              last_event_at:
                runningEntry.last_codex_timestamp !== null
                  ? runningEntry.last_codex_timestamp.toISOString()
                  : null,
              tokens: {
                input_tokens: runningEntry.codex_input_tokens,
                output_tokens: runningEntry.codex_output_tokens,
                total_tokens: runningEntry.codex_total_tokens,
              },
            }
          : null,
      retry:
        retryEntry !== undefined
          ? {
              attempt: retryEntry.attempt,
              due_at: new Date(retryEntry.due_at_ms).toISOString(),
              error: retryEntry.error,
              seconds_until_due: Math.max(
                0,
                (retryEntry.due_at_ms - now.getTime()) / 1000
              ),
            }
          : null,
    })
  })

  app.post("/api/v1/refresh", async (c) => {
    await Effect.runPromise(Queue.offer(pollTrigger, void 0 as void))
    return c.json({ queued: true, coalesced: false, requested_at: new Date().toISOString(), operations: ["poll", "reconcile"] }, 202)
  })

  app.all("*", (c) => {
    return new Response("Method Not Allowed", { status: 405 })
  })

  return app
}

// ─── startHttpServer ──────────────────────────────────────────────────────────

export function startHttpServer(
  port: number,
  stateRef: Ref.Ref<OrchestratorState>,
  pollTrigger: Queue.Queue<void>,
  host: string = "127.0.0.1"
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    if (port <= 0) return

    const app = makeApp(stateRef, pollTrigger)

    const server = Bun.serve({
      port,
      hostname: host,
      fetch: app.fetch,
    })

    yield* Effect.logInfo(`HTTP server started on http://${host}:${server.port}`)

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.stop()
      })
    )
  })
}
