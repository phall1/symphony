import { Effect, Exit, Layer, Scope, Stream, Cause } from "effect"
import { readFile, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
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

type OpenCodeModelSelector = {
  readonly providerID: string
  readonly modelID: string
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
  })

// ─── Per-workspace Server Mode ────────────────────────────────────────────────

const OPENCODE_SERVER_PID_FILE = ".symphony-opencode-serve.pid"

const pidFilePathForWorkspace = (workspacePath: string): string =>
  join(workspacePath, OPENCODE_SERVER_PID_FILE)

const readTrackedPid = (workspacePath: string): Effect.Effect<number | null> =>
  Effect.catch(
    Effect.tryPromise({
      try: async () => {
        const raw = await readFile(pidFilePathForWorkspace(workspacePath), "utf8")
        const pid = parseInt(raw.trim(), 10)
        return Number.isInteger(pid) && pid > 0 ? pid : null
      },
      catch: (err) => err,
    }),
    () => Effect.succeed(null),
  )

const writeTrackedPid = (workspacePath: string, pid: number): Effect.Effect<void> =>
  Effect.catch(
    Effect.tryPromise({
      try: () => writeFile(pidFilePathForWorkspace(workspacePath), `${pid}\n`, "utf8"),
      catch: (err) => err,
    }),
    () => Effect.void,
  )

const removeTrackedPidFile = (workspacePath: string): Effect.Effect<void> =>
  Effect.catch(
    Effect.tryPromise({
      try: () => rm(pidFilePathForWorkspace(workspacePath), { force: true }),
      catch: (err) => err,
    }),
    () => Effect.void,
  )

const isOpencodeServeProcess = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0)
    } catch {
      return false
    }

    const out = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const command = new TextDecoder().decode(out.stdout).trim()
    return command.includes("opencode serve")
  })

const reapTrackedServerForWorkspace = (workspacePath: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const trackedPid = yield* readTrackedPid(workspacePath)
    if (!trackedPid) return

    const isServe = yield* isOpencodeServeProcess(trackedPid)
    if (isServe) {
      yield* Effect.sync(() => {
        try {
          process.kill(trackedPid, "SIGTERM")
        } catch {
          return
        }
      })
      yield* Effect.logInfo("reaped stale opencode per-workspace server").pipe(
        Effect.annotateLogs("pid", String(trackedPid)),
        Effect.annotateLogs("workspace", workspacePath),
      )
    }

    yield* removeTrackedPidFile(workspacePath)
  })

/**
 * Spawns `opencode serve --port <n>` and parses the selected port from stdout.
 * Process killed via Effect.addFinalizer when scope closes.
 */
const spawnPerWorkspaceServer = (
  workspacePath: string,
  port: number,
): Effect.Effect<MutableConnection, AgentEngineError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* reapTrackedServerForWorkspace(workspacePath)

    const proc = Bun.spawn(["opencode", "serve", "--port", String(port)], {
      cwd: workspacePath,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })

    yield* writeTrackedPid(workspacePath, proc.pid)

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          try {
            proc.kill()
          } catch {
            // process may already be dead
          }
        })
        yield* removeTrackedPidFile(workspacePath)
      }),
    )

    // Parse ephemeral port from stdout — regex matches "port 12345", "port: 12345", "localhost:12345"
    const selectedPort = yield* Effect.tryPromise({
      try: async () => {
        const reader = proc.stdout.getReader()
        let accumulated = ""
        const deadline = Date.now() + 30_000

        while (Date.now() < deadline) {
          const { value, done } = await reader.read()
          if (done) break
          accumulated += new TextDecoder().decode(value)

          const portMatch = accumulated.match(
            /(?:port\s*[=:]\s*|listening\s+on\s+(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):?|(?:localhost|127\.0\.0\.1):)(\d+)/i,
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
      Effect.annotateLogs("port", String(selectedPort)),
      Effect.annotateLogs("workspace", workspacePath),
    )

    return {
      baseUrl: `http://localhost:${selectedPort}`,
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
): Effect.Effect<Stream.Stream<OpenCodeSSEEvent, AgentSessionError>, AgentSessionError> =>
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
  })

const parseSSEStream = (
  body: ReadableStream<Uint8Array>,
  sessionId: string,
): Stream.Stream<OpenCodeSSEEvent, AgentSessionError> => {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

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

          const result = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: (err) => new AgentSessionError({
              message: `SSE read error: ${String(err)}`,
              cause: err,
            }),
          })

          if (result.done) {
            return yield* Effect.fail(new AgentSessionError({
              message: "SSE stream closed unexpectedly before a terminal session event was observed",
            }))
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

const toModelSelector = (model: string | undefined): OpenCodeModelSelector | undefined => {
  const trimmed = model?.trim()
  if (!trimmed) return undefined

  const slashIndex = trimmed.indexOf("/")
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) return undefined

  return {
    providerID: trimmed.slice(0, slashIndex),
    modelID: trimmed.slice(slashIndex + 1),
  }
}

const formatUnknownError = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

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
    return { agentEvent: { type: "turn_failed", error: formatUnknownError(errorMsg) }, terminal: true }
  }

  if (eventType === "permission.asked") {
    const desc = (data as Record<string, unknown>)["description"] ??
      (data as Record<string, unknown>)["title"] ?? "permission"
    return { agentEvent: { type: "approval_auto_approved", description: String(desc) }, terminal: false }
  }

  if (eventType === "message.updated") {
    const info = (data as Record<string, unknown>)["info"] as Record<string, unknown> | undefined
    const tokens = info?.["tokens"] as Record<string, unknown> | undefined
    const input = typeof tokens?.["input"] === "number" ? tokens["input"] : undefined
    const output = typeof tokens?.["output"] === "number" ? tokens["output"] : undefined
    const total = typeof tokens?.["total"] === "number" ? tokens["total"] : undefined
    if (input !== undefined && output !== undefined && total !== undefined) {
      return {
        agentEvent: { type: "token_usage", input, output, total },
        terminal: false,
      }
    }
  }

  if (eventType === "message.part.updated") {
    const part = (data as Record<string, unknown>)["part"] as Record<string, unknown> | undefined
    const content = part?.["text"] ??
      (data as Record<string, unknown>)["content"] ??
      (data as Record<string, unknown>)["text"] ?? ""

    if (typeof content === "string" && content.length > 0) {
      return { agentEvent: { type: "notification", message: content.slice(0, 500) }, terminal: false }
    }
  }

  if (eventType === "message.part.delta") {
    const delta = (data as Record<string, unknown>)["delta"]
    if (typeof delta === "string" && delta.length > 0) {
      return { agentEvent: { type: "notification", message: delta.slice(0, 500) }, terminal: false }
    }
  }

  if (eventType === "server.heartbeat") {
    return { agentEvent: { type: "stall_heartbeat" }, terminal: false }
  }

  return { agentEvent: { type: "other", raw: event }, terminal: false }
}

// ─── Auto-approve Permissions ─────────────────────────────────────────────────

const autoApprovePermission = (
  baseUrl: string,
  sessionId: string,
  permissionId: string,
  workspacePath: string,
): Effect.Effect<void> =>
  postNoBody(
    baseUrl,
    `/session/${sessionId}/permissions/${permissionId}`,
    { response: "approve" },
    workspacePath,
  ).pipe(
    Effect.catch(() =>
      postNoBody(baseUrl, `/permission/${permissionId}`, { reply: "approve" }, workspacePath),
    ),
    Effect.catch((error) => Effect.logDebug("permission auto-approve failed").pipe(Effect.annotateLogs("cause", error.message))),
  )

// ─── OpenCodeAgentEngine ──────────────────────────────────────────────────────

export function makeOpenCodeAgentEngineService(): AgentEngine["Service"] {
  return {
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
          const requestedPort = ocConfig.port > 0 ? ocConfig.port : 0
          yield* Effect.logDebug("opencode per-workspace server launch config").pipe(
            Effect.annotateLogs("requested_port", String(requestedPort)),
            Effect.annotateLogs("workspace", workspacePath),
          )
          connection = yield* spawnPerWorkspaceServer(workspacePath, requestedPort).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError((cause) => new AgentEngineError({
              message: "Failed to spawn opencode server",
              cause,
            })),
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

          runTurn: (turnInput): Stream.Stream<AgentEvent, AgentSessionError> => {
            const turnStream: Effect.Effect<Stream.Stream<AgentEvent, AgentSessionError>, AgentSessionError> = Effect.gen(function* () {
              const started: AgentEvent = { type: "session_started", sessionId }
              const modelSelector = toModelSelector(ocConfig.model)

              yield* Effect.logInfo("opencode turn start").pipe(
                Effect.annotateLogs("sessionId", sessionId),
                Effect.annotateLogs("agent", ocConfig.agent || "(unset)"),
                Effect.annotateLogs("model", ocConfig.model || "(unset)"),
              )

              const sseEvents = yield* subscribeSSE(baseUrl, sessionId, workspacePath)

              const promptError = yield* postNoBody(
                baseUrl,
                `/session/${sessionId}/prompt_async`,
                {
                  parts: [{ type: "text", text: turnInput.prompt }],
                  ...(ocConfig.agent ? { agent: ocConfig.agent } : {}),
                  ...(modelSelector ? { model: modelSelector } : {}),
                },
                workspacePath,
              ).pipe(
                Effect.mapError((err) => new AgentSessionError({
                  message: err.message,
                  cause: err.cause,
                })),
                Effect.as(null as AgentSessionError | null),
                Effect.catch((err) => Effect.succeed(err)),
              )

              if (promptError) {
                return Stream.concat(
                  Stream.make(started),
                  Stream.make({ type: "turn_failed", error: promptError.message } as AgentEvent),
                )
              }

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
                        autoApprovePermission(baseUrl, sessionId, permId, workspacePath).pipe(
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
              ).pipe(Effect.catch((error) => Effect.logDebug("session abort request failed").pipe(Effect.annotateLogs("cause", error.message))))
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
  }
}

export const makeOpenCodeAgentEngineLive = (): Layer.Layer<AgentEngine> =>
  Layer.succeed(AgentEngine, makeOpenCodeAgentEngineService())
