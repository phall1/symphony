import { Effect, Exit, Layer, Scope, Stream, Cause } from "effect"
import { AgentEngine } from "../agent.js"
import { AgentEngineError, AgentSessionError } from "../agent.js"
import type { AgentSession } from "../agent.js"
import type { AgentEvent } from "../../types.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface OpenCodeSSEEvent {
  readonly type: string
  readonly sessionID?: string
  readonly data?: Record<string, unknown>
  readonly properties?: Record<string, unknown>
  readonly [key: string]: unknown
}

interface ServerConnection {
  readonly baseUrl: string
  readonly process?: { kill: () => void }
}

// Mutable wrapper so we can attach scope for later disposal without `as any` on a readonly interface
interface MutableConnection {
  baseUrl: string
  process?: { kill: () => void }
  __scope?: Scope.Closeable
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

const jsonPost = (
  baseUrl: string,
  path: string,
  body: unknown,
  workspacePath: string,
): Effect.Effect<Record<string, unknown>, AgentEngineError> =>
  Effect.gen(function* () {
    const resp = yield* Effect.tryPromise({
      try: () =>
        fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-directory": workspacePath,
          },
          body: JSON.stringify(body),
        }),
      catch: (err) => new AgentEngineError({
        message: `HTTP POST ${path} failed: ${String(err)}`,
        cause: err,
      }),
    })

    if (!resp.ok) {
      const text = yield* Effect.tryPromise({
        try: () => resp.text(),
        catch: () => new AgentEngineError({ message: "Failed to read error body" }),
      })
      return yield* Effect.fail(new AgentEngineError({
        message: `HTTP POST ${path} returned ${resp.status}: ${text}`,
      }))
    }

    return (yield* Effect.tryPromise({
      try: () => resp.json() as Promise<Record<string, unknown>>,
      catch: (err) => new AgentEngineError({
        message: `Failed to parse JSON from ${path}: ${String(err)}`,
        cause: err,
      }),
    }))
  })

const postNoBody = (
  baseUrl: string,
  path: string,
  body: unknown,
  workspacePath: string,
): Effect.Effect<void, AgentEngineError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-directory": workspacePath,
          },
          body: JSON.stringify(body),
        }),
      catch: (err) => new AgentEngineError({
        message: `HTTP POST ${path} failed: ${String(err)}`,
        cause: err,
      }),
    })
  })

// ─── Per-workspace Server Mode ────────────────────────────────────────────────

/**
 * Spawns `opencode serve --port 0` and parses the ephemeral port from stdout.
 * Process killed via Effect.addFinalizer when scope closes.
 */
const spawnPerWorkspaceServer = (
  workspacePath: string,
): Effect.Effect<MutableConnection, AgentEngineError, Scope.Scope> =>
  Effect.gen(function* () {
    const proc = Bun.spawn(["opencode", "serve", "--port", "0"], {
      cwd: workspacePath,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          proc.kill()
        } catch {
          // process may already be dead
        }
      }),
    )

    // Parse ephemeral port from stdout — regex matches "port 12345", "port: 12345", "localhost:12345"
    const port = yield* Effect.tryPromise({
      try: async () => {
        const reader = proc.stdout.getReader()
        let accumulated = ""
        const deadline = Date.now() + 30_000

        while (Date.now() < deadline) {
          const { value, done } = await reader.read()
          if (done) break
          accumulated += new TextDecoder().decode(value)

          const portMatch = accumulated.match(
            /(?:port\s*[=:]\s*|listening\s+on\s+(?:port\s+)?|localhost:)(\d+)/i,
          )
          if (portMatch?.[1]) {
            reader.releaseLock()
            return parseInt(portMatch[1], 10)
          }
        }
        reader.releaseLock()
        throw new Error(`Could not parse port from opencode stdout within 30s. Output: ${accumulated.slice(0, 500)}`)
      },
      catch: (err) => new AgentEngineError({
        message: `Failed to spawn opencode server: ${String(err)}`,
        cause: err,
      }),
    })

    yield* Effect.logInfo("opencode per-workspace server started").pipe(
      Effect.annotateLogs("port", String(port)),
      Effect.annotateLogs("workspace", workspacePath),
    )

    return {
      baseUrl: `http://localhost:${port}`,
      process: { kill: () => proc.kill() },
    }
  })

// ─── Shared Server Mode ───────────────────────────────────────────────────────

const connectSharedServer = (serverUrl: string): MutableConnection => ({
  baseUrl: serverUrl.replace(/\/+$/, ""),
})

// ─── SSE Event Stream ─────────────────────────────────────────────────────────

/**
 * SSE subscription to GET /event filtered by sessionID.
 * Uses Stream.unfold to lazily parse chunks from the ReadableStream.
 */
const subscribeSSE = (
  baseUrl: string,
  sessionId: string,
  workspacePath: string,
): Stream.Stream<OpenCodeSSEEvent, AgentSessionError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const resp = yield* Effect.tryPromise({
        try: () =>
          fetch(`${baseUrl}/event`, {
            headers: {
              Accept: "text/event-stream",
              "x-opencode-directory": workspacePath,
            },
          }),
        catch: (err) => new AgentSessionError({
          message: `SSE connection failed: ${String(err)}`,
          cause: err,
        }),
      })

      if (!resp.ok || !resp.body) {
        return yield* Effect.fail(new AgentSessionError({
          message: `SSE connection returned ${resp.status}`,
        }))
      }

      return parseSSEStream(resp.body, sessionId)
    }),
  )

const parseSSEStream = (
  body: ReadableStream<Uint8Array>,
  sessionId: string,
): Stream.Stream<OpenCodeSSEEvent, AgentSessionError> => {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let streamDone = false

  return Stream.unfold<OpenCodeSSEEvent[], OpenCodeSSEEvent, AgentSessionError, never>(
    [],
    (_pendingEvents) =>
      Effect.gen(function* () {
        let pending = _pendingEvents

        while (true) {
          if (pending.length > 0) {
            const event = pending[0]!
            return [event, pending.slice(1)] as const
          }

          if (streamDone) return undefined

          const result = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: (err) => new AgentSessionError({
              message: `SSE read error: ${String(err)}`,
              cause: err,
            }),
          })

          if (result.done) {
            streamDone = true
            return undefined
          }

          buffer += decoder.decode(result.value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          const newEvents: OpenCodeSSEEvent[] = []
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const parsed = JSON.parse(line.slice(6)) as OpenCodeSSEEvent
                const eventSessionId =
                  parsed.sessionID ??
                  (parsed.properties as Record<string, unknown> | undefined)?.["sessionID"]
                if (eventSessionId === sessionId || eventSessionId === undefined) {
                  newEvents.push(parsed)
                }
              } catch {
                // malformed JSON — skip
              }
            }
          }

          pending = newEvents
        }
      }),
  )
}

// ─── Event Mapping ────────────────────────────────────────────────────────────

// Maps OpenCode SSE event → AgentEvent + terminal flag
const mapSSEEvent = (
  event: OpenCodeSSEEvent,
): { agentEvent: AgentEvent; terminal: boolean } => {
  const eventType = event.type
  const data = event.data ?? event.properties ?? {}

  if (eventType === "session.status") {
    const statusType = (data as Record<string, unknown>)["type"] ??
      ((data as Record<string, unknown>)["status"] as Record<string, unknown> | undefined)?.["type"]
    if (statusType === "idle") {
      return { agentEvent: { type: "turn_completed" }, terminal: true }
    }
  }

  if (eventType === "session.error") {
    const errorMsg = (data as Record<string, unknown>)["error"] ??
      (data as Record<string, unknown>)["message"] ?? "Unknown session error"
    return { agentEvent: { type: "turn_failed", error: String(errorMsg) }, terminal: true }
  }

  if (eventType === "permission.asked") {
    const desc = (data as Record<string, unknown>)["description"] ??
      (data as Record<string, unknown>)["title"] ?? "permission"
    return { agentEvent: { type: "approval_auto_approved", description: String(desc) }, terminal: false }
  }

  if (eventType === "message.part.updated") {
    const content = (data as Record<string, unknown>)["content"] ??
      (data as Record<string, unknown>)["text"] ?? ""
    return { agentEvent: { type: "notification", message: String(content).slice(0, 500) }, terminal: false }
  }

  if (eventType === "server.heartbeat") {
    return { agentEvent: { type: "stall_heartbeat" }, terminal: false }
  }

  return { agentEvent: { type: "other", raw: event }, terminal: false }
}

// ─── Auto-approve Permissions ─────────────────────────────────────────────────

const autoApprovePermission = (
  baseUrl: string,
  permissionId: string,
  workspacePath: string,
): Effect.Effect<void> =>
  postNoBody(baseUrl, `/permission/${permissionId}`, { reply: "approve" }, workspacePath).pipe(
    Effect.catchCause((cause) => Effect.logDebug("permission auto-approve failed").pipe(Effect.annotateLogs("cause", Cause.pretty(cause)))),
  )

// ─── OpenCodeAgentEngine ──────────────────────────────────────────────────────

export const makeOpenCodeAgentEngineLive = (): Layer.Layer<AgentEngine> =>
  Layer.succeed(AgentEngine, {
    createSession: (input) =>
      Effect.gen(function* () {
        const { workspace, cwd, config } = input
        const ocConfig = config.opencode
        const workspacePath = cwd

        let connection: MutableConnection

        if (ocConfig.mode === "shared" && ocConfig.server_url) {
          connection = connectSharedServer(ocConfig.server_url)
          yield* Effect.logInfo("opencode shared server connected").pipe(
            Effect.annotateLogs("url", connection.baseUrl),
          )
        } else {
          const scope = yield* Scope.make()
          connection = yield* spawnPerWorkspaceServer(workspacePath).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.catchCause((cause) =>
              Effect.fail(new AgentEngineError({
                message: "Failed to spawn opencode server",
                cause,
              })),
            ),
          )
          connection.__scope = scope
        }

        const baseUrl = connection.baseUrl

        const sessionResp = yield* jsonPost(
          baseUrl,
          "/session",
          { title: `${workspace}` },
          workspacePath,
        )

        const sessionId = sessionResp["id"] as string | undefined
        if (!sessionId) {
          return yield* Effect.fail(new AgentEngineError({
            message: "Invalid /session response: missing id",
            cause: sessionResp,
          }))
        }

        yield* Effect.logInfo("opencode session created").pipe(
          Effect.annotateLogs("sessionId", sessionId),
          Effect.annotateLogs("workspace", workspacePath),
        )

        const session: AgentSession = {
          sessionId,
          threadId: sessionId,

          runTurn: (turnInput) => {
            const turnStream = Effect.gen(function* () {
              const started: AgentEvent = { type: "session_started", sessionId }

              yield* jsonPost(
                baseUrl,
                `/session/${sessionId}/message`,
                {
                  parts: [{ type: "text", text: turnInput.prompt }],
                  ...(ocConfig.agent ? { agent: ocConfig.agent } : {}),
                  ...(ocConfig.model ? { model: ocConfig.model } : {}),
                },
                workspacePath,
              ).pipe(
                Effect.mapError((err) => new AgentSessionError({
                  message: err.message,
                  cause: err.cause,
                })),
              )

              const sseEvents = subscribeSSE(baseUrl, sessionId, workspacePath)

              const agentEvents: Stream.Stream<AgentEvent, AgentSessionError> = Stream.flatMap(
                sseEvents,
                (sseEvent) => {
                  const { agentEvent } = mapSSEEvent(sseEvent)

                  if (sseEvent.type === "permission.asked") {
                    const permId =
                      (sseEvent.data as Record<string, unknown> | undefined)?.["id"] ??
                      (sseEvent.properties as Record<string, unknown> | undefined)?.["id"] ??
                      sseEvent["id"]
                    if (typeof permId === "string") {
                      return Stream.unwrap(
                        autoApprovePermission(baseUrl, permId, workspacePath).pipe(
                          Effect.map(() => Stream.make(agentEvent)),
                        ),
                      )
                    }
                  }

                  return Stream.make(agentEvent)
                },
              )

              const bounded = Stream.takeUntil(agentEvents, (evt) =>
                evt.type === "turn_completed" || evt.type === "turn_failed",
              )

              return Stream.concat(Stream.make(started), bounded)
            })

            return Stream.unwrap(
              turnStream.pipe(
                Effect.mapError((err) => new AgentSessionError({
                  message: typeof err === "object" && err !== null && "message" in err ? String(err.message) : String(err),
                  cause: err,
                })),
              ),
            )
          },

          abort: () =>
            Effect.gen(function* () {
              yield* jsonPost(
                baseUrl,
                `/session/${sessionId}/abort`,
                {},
                workspacePath,
              ).pipe(Effect.catchCause((cause) => Effect.logDebug("session abort request failed").pipe(Effect.annotateLogs("cause", Cause.pretty(cause)))))
              yield* Effect.logInfo("opencode session aborted").pipe(
                Effect.annotateLogs("sessionId", sessionId),
              )
            }),

          dispose: () =>
            Effect.gen(function* () {
              const scope = connection.__scope
              if (scope) {
                yield* Scope.close(scope, Exit.void)
              }
              yield* Effect.logInfo("opencode session disposed").pipe(
                Effect.annotateLogs("sessionId", sessionId),
              )
            }),
        }

        return session
      }),
  })
