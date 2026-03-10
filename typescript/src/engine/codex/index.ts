import { Effect, Exit, Layer, Queue, Ref, Scope, Stream, Cause } from "effect"
import { AgentEngine } from "../agent.js"
import { AgentEngineError, AgentSessionError } from "../agent.js"
import type { AgentSession } from "../agent.js"
import type { AgentEvent, ResolvedConfig } from "../../types.js"
import { launchCodexProcess } from "./process.js"
import type { CodexProcess } from "./process.js"
import { streamTurn } from "./streaming.js"
import type { LinearHandler } from "./streaming.js"
import type { CodexProtocol } from "./protocol.js"
import { graphqlRequest } from "../../tracker/linear.js"

export type { CodexProtocol } from "./protocol.js"

// ─── Protocol Bridge ──────────────────────────────────────────────────────────

/**
 * Bridges process stdin/stdout with JSON-RPC request/response matching.
 * The lineQueue is fed by a fiber consuming proc.lines.
 * sendRequest writes to stdin and awaits a matching response by ID.
 */
const makeProtocol = (
  proc: CodexProcess,
  lineQueue: Queue.Queue<string>,
  requestIdRef: Ref.Ref<number>,
  readTimeoutMs: number,
): CodexProtocol => {
  const sendRequest = (
    method: string,
    params: unknown,
  ): Effect.Effect<Record<string, unknown>, AgentEngineError> =>
    Effect.gen(function* () {
      const id = yield* Ref.getAndUpdate(requestIdRef, (n) => n + 1)
      yield* proc.write(JSON.stringify({ id, method, params }))
      return yield* awaitResponse(lineQueue, id, readTimeoutMs)
    })

  const sendNotification = (method: string, params: unknown): Effect.Effect<void> =>
    proc.write(JSON.stringify({ method, params }))

  const sendResponse = (id: unknown, result: unknown): Effect.Effect<void> =>
    proc.write(JSON.stringify({ id, result }))

  return { sendRequest, sendNotification, sendResponse }
}

/**
 * Waits for a JSON-RPC response with matching ID.
 * Non-matching messages are re-queued for later consumption.
 */
const awaitResponse = (
  lineQueue: Queue.Queue<string>,
  expectedId: number,
  readTimeoutMs: number,
): Effect.Effect<Record<string, unknown>, AgentEngineError> =>
  Effect.gen(function* () {
    const skipped: string[] = []

    const result = yield* Effect.gen(function* () {
      while (true) {
        const line = yield* Queue.take(lineQueue).pipe(
          Effect.timeout(readTimeoutMs),
          Effect.catchCause(() =>
            Effect.fail(new AgentEngineError({
              message: "response_timeout: no response within read_timeout_ms",
            })),
          ),
        )

        try {
          const parsed = JSON.parse(line) as Record<string, unknown>
          if (parsed["id"] === expectedId) {
            if (parsed["error"] != null) {
              return yield* Effect.fail(new AgentEngineError({
                message: `response_error: ${JSON.stringify(parsed["error"])}`,
                cause: parsed["error"],
              }))
            }
            return parsed["result"] as Record<string, unknown>
          }
          skipped.push(line)
        } catch {
          yield* Effect.logDebug("handshake: skipping non-JSON line").pipe(
            Effect.annotateLogs("line", line.slice(0, 200)),
          )
        }
      }
      throw new Error("unreachable") // TypeScript control flow
    })

    for (const line of skipped) {
      yield* Queue.offer(lineQueue, line)
    }

    return result
  })

// ─── CodexAgentEngine ─────────────────────────────────────────────────────────

export const makeCodexAgentEngineLive = (): Layer.Layer<AgentEngine> =>
  Layer.succeed(AgentEngine, {
    createSession: (input) =>
      Effect.gen(function* () {
        const { cwd, config } = input
        const codexConfig = config.codex

        const scope = yield* Scope.make()

        const proc = yield* launchCodexProcess(cwd, codexConfig).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.catchCause((cause) =>
            Effect.fail(new AgentEngineError({
              message: "Failed to launch codex process",
              cause,
            })),
          ),
        )

        yield* Effect.logInfo("codex process launched").pipe(
          Effect.annotateLogs("pid", String(proc.pid)),
          Effect.annotateLogs("workspace", cwd),
        )

        const lineQueue = yield* Queue.unbounded<string>()
        const requestIdRef = yield* Ref.make(1)

        yield* Effect.forkChild(
          Stream.runForEach(proc.lines, (line) => Queue.offer(lineQueue, line)).pipe(
            Effect.catchCause((cause) => Effect.logDebug("line queue consumer exited").pipe(Effect.annotateLogs("cause", Cause.pretty(cause)))),
          ),
        )

        const protocol = makeProtocol(
          proc,
          lineQueue,
          requestIdRef,
          codexConfig.read_timeout_ms || 5000,
        )

        const linearHandler: LinearHandler | undefined =
          config.tracker.kind === "linear" && config.tracker.api_key
            ? async (query: string, variables?: Record<string, unknown>): Promise<unknown> => {
                return Effect.runPromise(graphqlRequest(
                  config.tracker.endpoint,
                  config.tracker.api_key,
                  query,
                  variables ?? {},
                ))
              }
            : undefined

        const autoApproveAll = codexConfig.approval_policy === "never"

        const initHandshake = yield* performInitAndThread(
          protocol,
          cwd,
          codexConfig,
          !!linearHandler,
        )

        const threadId = initHandshake.threadId

        const session: AgentSession = {
          sessionId: `${threadId}-pending`,
          threadId,

          runTurn: (turnInput) => {
            const turnEffect = Effect.gen(function* () {
              const turnId = yield* Ref.getAndUpdate(requestIdRef, (n) => n + 1)
              const approvalPolicy = codexConfig.approval_policy ?? {
                reject: { sandbox_approval: true, rules: true, mcp_elicitations: true },
              }
              const turnSandboxPolicy = codexConfig.turn_sandbox_policy ?? {
                type: "workspaceWrite",
                workspacePath: cwd,
              }

              yield* proc.write(
                JSON.stringify({
                  id: turnId,
                  method: "turn/start",
                  params: {
                    threadId,
                    input: [{ type: "text", text: turnInput.prompt }],
                    cwd,
                    title: turnInput.title,
                    approvalPolicy,
                    sandboxPolicy: turnSandboxPolicy,
                  },
                }),
              )

              const turnResult = yield* awaitResponse(lineQueue, turnId, codexConfig.read_timeout_ms || 5000)
              const turnPayload = turnResult["turn"] as Record<string, unknown> | undefined
              const turnIdStr =
                turnPayload && typeof turnPayload["id"] === "string"
                  ? (turnPayload["id"] as string)
                  : "unknown"

              return `${threadId}-${turnIdStr}`
            })

            return Stream.unwrap(
              turnEffect.pipe(
                Effect.map((sessionId) => {
                  const sessionStarted: Stream.Stream<AgentEvent, AgentSessionError> =
                    Stream.make({ type: "session_started" as const, sessionId, pid: String(proc.pid) })

                  const turnEvents = streamTurn(
                    lineQueue,
                    protocol,
                    codexConfig.turn_timeout_ms || 3600000,
                    {
                      autoApproveAll,
                      ...(linearHandler ? { linearHandler } : {}),
                    },
                  )

                  return Stream.concat(sessionStarted, turnEvents)
                }),
                Effect.mapError((err) => new AgentSessionError({
                  message: err.message,
                  cause: err.cause,
                })),
              ),
            )
          },

          abort: () =>
            Effect.gen(function* () {
              yield* proc.kill()
              yield* Effect.logInfo("codex session aborted")
            }),

          dispose: () =>
            Effect.gen(function* () {
              yield* Scope.close(scope, Exit.void)
              yield* Effect.logInfo("codex session disposed")
            }),
        }

        return session
      }),
  })

/**
 * Perform initialize + initialized + thread/start (without turn/start).
 * Returns threadId for reuse across continuation turns.
 */
const performInitAndThread = (
  protocol: CodexProtocol,
  workspace: string,
  config: ResolvedConfig["codex"],
  hasLinearTool: boolean,
): Effect.Effect<{ threadId: string }, AgentEngineError> =>
  Effect.gen(function* () {
    const approvalPolicy = config.approval_policy ?? {
      reject: { sandbox_approval: true, rules: true, mcp_elicitations: true },
    }
    const threadSandbox = config.thread_sandbox || "workspace-write"

    yield* protocol.sendRequest("initialize", {
      clientInfo: { name: "symphony", version: "1.0" },
      capabilities: hasLinearTool ? { dynamicTools: { enabled: true } } : {},
    })

    yield* protocol.sendNotification("initialized", {})

    const threadResult = yield* protocol.sendRequest("thread/start", {
      approvalPolicy,
      sandbox: threadSandbox,
      cwd: workspace,
      ...(hasLinearTool ? {
        dynamicTools: [{
          name: "linear_graphql",
          description: "Execute a raw GraphQL query or mutation against Linear using Symphony's configured tracker auth.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "GraphQL query or mutation document (exactly one operation)" },
              variables: { type: "object", description: "Optional GraphQL variables object" },
            },
            required: ["query"],
          },
        }],
      } : {}),
    })

    const threadPayload = threadResult["thread"] as Record<string, unknown> | undefined
    if (!threadPayload || typeof threadPayload["id"] !== "string") {
      return yield* Effect.fail(new AgentEngineError({
        message: "Invalid thread/start response: missing thread.id",
        cause: threadResult,
      }))
    }

    return { threadId: threadPayload["id"] as string }
  })
