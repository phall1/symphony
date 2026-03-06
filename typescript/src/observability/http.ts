import { Effect, Ref, Scope } from "effect"
import { Hono } from "hono"
import type { OrchestratorState } from "../types.js"
import { buildSnapshot } from "./snapshot.js"

// ─── Hono app factory ─────────────────────────────────────────────────────────

function makeApp(stateRef: Ref.Ref<OrchestratorState>): Hono {
  const app = new Hono()

  app.get("/", (c) => c.text("Symphony is running."))

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

  app.post("/api/v1/refresh", (c) => {
    const requested_at = new Date().toISOString()
    return c.json(
      {
        queued: true,
        coalesced: false,
        requested_at,
        operations: ["poll", "reconcile"],
      },
      202
    )
  })

  app.all("*", (c) => {
    return new Response("Method Not Allowed", { status: 405 })
  })

  return app
}

// ─── startHttpServer ──────────────────────────────────────────────────────────

export function startHttpServer(
  port: number,
  stateRef: Ref.Ref<OrchestratorState>
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    if (port <= 0) return

    const app = makeApp(stateRef)

    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: app.fetch,
    })

    yield* Effect.logInfo(`HTTP server started on http://127.0.0.1:${server.port}`)

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.stop()
      })
    )
  })
}
