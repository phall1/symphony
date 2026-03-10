import { Effect, Stream, Queue } from "effect"
import type { AgentEvent, TokenUsage } from "../../types.js"
import { AgentSessionError } from "../agent.js"
import type { CodexProtocol } from "./protocol.js"

// ─── Types ────────────────────────────────────────────────────────────────────

export type LinearHandler = (query: string, variables?: Record<string, unknown>) => Promise<unknown>

export interface StreamTurnOptions {
  autoApproveAll?: boolean
  linearHandler?: LinearHandler
}

// ─── Method Sets ──────────────────────────────────────────────────────────────

const APPROVAL_METHODS = new Set([
  "item/approval/request",
  "item/command/execute/approval",
  "item/patch/approval",
  "approval-request",
  "item/commandExecution/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
  "item/fileChange/requestApproval",
])

const TOKEN_USAGE_METHODS = new Set([
  "thread/tokenUsage/updated",
  "thread/token_usage/updated",
])

const INPUT_REQUIRED_METHODS = new Set([
  "item/tool/requestUserInput",
])

// ─── Stream Turn ──────────────────────────────────────────────────────────────

export const streamTurn = (
  lineQueue: Queue.Queue<string>,
  protocol: CodexProtocol,
  turnTimeoutMs: number,
  options?: StreamTurnOptions,
): Stream.Stream<AgentEvent, AgentSessionError> => {
  const opts: StreamTurnOptions = options ?? {}

  const processNextLine: Effect.Effect<
    AgentEvent | null,
    AgentSessionError
  > = Effect.gen(function* () {
    const line = yield* Queue.take(lineQueue).pipe(
      Effect.timeout(turnTimeoutMs),
      Effect.catchCause(() =>
        Effect.fail(new AgentSessionError({
          message: "turn_timeout: no message within turn_timeout_ms",
        })),
      ),
    )

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      return { type: "other" as const, raw: line }
    }

    const method = parsed["method"] as string | undefined
    if (!method) {
      return { type: "other" as const, raw: parsed }
    }

    return yield* mapProtocolMessage(method, parsed, protocol, opts)
  })

  return Stream.unfold<boolean, AgentEvent, AgentSessionError, never>(false, (done) => {
    if (done) return Effect.succeed(undefined)
    return processNextLine.pipe(
      Effect.map((event) => {
        if (event === null) return undefined
        const isTerminal =
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_cancelled"
        return [event, isTerminal] as const
      }),
    )
  })
}

const mapProtocolMessage = (
  method: string,
  payload: Record<string, unknown>,
  protocol: CodexProtocol,
  options: StreamTurnOptions,
): Effect.Effect<AgentEvent | null, AgentSessionError> =>
  Effect.gen(function* () {
    // Unwrap codex/event/* wrappers — Codex nests events inside these
    if (method.startsWith("codex/event/")) {
      const innerMethod = method.slice("codex/event/".length)
      const innerPayload = { ...payload, method: innerMethod }
      const innerEffect: Effect.Effect<AgentEvent | null, AgentSessionError> =
        mapProtocolMessage(innerMethod, innerPayload, protocol, options)
      return yield* innerEffect
    }

    if (method === "turn/completed") {
      const usage = extractUsage(payload)
      const event: AgentEvent = usage
        ? { type: "turn_completed", usage }
        : { type: "turn_completed" }
      return event
    }

    if (method === "turn/failed") {
      const params = payload["params"] as Record<string, unknown> | undefined
      return {
        type: "turn_failed" as const,
        error: params ? JSON.stringify(params) : "turn_failed",
      }
    }

    if (method === "turn/cancelled") {
      return { type: "turn_cancelled" as const }
    }

    // Token usage
    if (TOKEN_USAGE_METHODS.has(method)) {
      const usage = extractTokenUsage(payload)
      if (usage) return usage
      return { type: "other" as const, raw: payload }
    }

    // Approval requests — auto-approve
    if (APPROVAL_METHODS.has(method)) {
      const id = payload["id"]
      if (id != null) {
        yield* protocol.sendResponse(id, { approved: true })
      }
      return {
        type: "approval_auto_approved" as const,
        description: `auto-approved ${method}`,
      }
    }

    // User input required
    if (INPUT_REQUIRED_METHODS.has(method)) {
      if (options.autoApproveAll) {
        const id = payload["id"]
        if (id != null) {
          yield* protocol.sendResponse(id, { approved: true })
        }
        return {
          type: "approval_auto_approved" as const,
          description: "auto-approved user input request (approval_policy: never)",
        }
      }
      return yield* Effect.fail(new AgentSessionError({
        message: "turn_input_required: agent requested user input",
        cause: payload,
      }))
    }

    // Tool calls
    if (method === "item/tool/call") {
      const params = payload["params"] as Record<string, unknown> | undefined
      const toolName = (params?.["name"] ?? payload["name"]) as string | undefined
      const id = payload["id"]

      if (toolName === "linear_graphql" && options.linearHandler) {
        const toolInput = (params?.["input"] ?? payload["input"]) as Record<string, unknown> | undefined
        const query = toolInput?.["query"] as string | undefined
        const variables = toolInput?.["variables"] as Record<string, unknown> | undefined

        if (!query || typeof query !== "string" || query.trim() === "") {
          if (id != null) {
            yield* protocol.sendResponse(id, {
              success: false,
              error: "invalid_input: query must be a non-empty string",
            })
          }
          return { type: "other" as const, raw: { tool_call: "linear_graphql", error: "invalid_input" } }
        }

        // Execute handler — wrap errors as defects so stream error channel stays AgentSessionError
        const handler = options.linearHandler
        yield* Effect.catchCause(
          Effect.gen(function* () {
            const data = yield* Effect.promise(() => handler(query, variables))
            if (id != null) yield* protocol.sendResponse(id, { success: true, data })
          }),
          (_cause) =>
            id != null
              ? protocol.sendResponse(id, { success: false, error: "linear_graphql execution failed" })
              : Effect.void,
        )
        return { type: "notification" as const, message: "linear_graphql tool executed" }
      }

      // Fallback: unsupported tool
      if (id != null) {
        yield* protocol.sendResponse(id, {
          success: false,
          error: "unsupported_tool_call",
        })
      }
      return {
        type: "other" as const,
        raw: { unsupported_tool_call: true, method, payload },
      }
    }

    // Rate limit events
    if (method.includes("rate_limit") || method.includes("rateLimit")) {
      return { type: "rate_limit" as const, payload }
    }

    // Check for input-required patterns in turn/* methods
    if (method.startsWith("turn/") && needsInput(method, payload)) {
      return yield* Effect.fail(new AgentSessionError({
        message: "turn_input_required: agent requested user input",
        cause: payload,
      }))
    }

    // Default: notification
    return { type: "notification" as const, message: method }
  })

// ─── Helpers ──────────────────────────────────────────────────────────────────

const extractUsage = (
  payload: Record<string, unknown>,
): { input_tokens: number; output_tokens: number; total_tokens: number } | undefined => {
  const usage = (payload["usage"] ?? payload["params"]) as Record<string, unknown> | undefined
  if (!usage) return undefined
  const input = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0
  const output = typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0
  const total = typeof usage["total_tokens"] === "number" ? usage["total_tokens"] : input + output
  return { input_tokens: input, output_tokens: output, total_tokens: total }
}

const extractTokenUsage = (payload: Record<string, unknown>): AgentEvent | null => {
  // Shape 1: params.usage (thread/tokenUsage/updated)
  const params = payload["params"] as Record<string, unknown> | undefined
  const usage = params?.["usage"] as Record<string, unknown> | undefined
  if (usage) {
    const input = typeof usage["inputTokens"] === "number" ? usage["inputTokens"]
      : typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0
    const output = typeof usage["outputTokens"] === "number" ? usage["outputTokens"]
      : typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0
    const total = typeof usage["totalTokens"] === "number" ? usage["totalTokens"]
      : typeof usage["total_tokens"] === "number" ? usage["total_tokens"] : input + output
    return { type: "token_usage", input, output, total }
  }

  // Shape 2: total_token_usage wrapper
  const totalUsageWrapper = payload["total_token_usage"] as Record<string, unknown> | undefined
  const totalTokenUsage = totalUsageWrapper?.["token_usage"] as Record<string, unknown> | undefined
  if (totalTokenUsage) {
    const input = typeof totalTokenUsage["inputTokens"] === "number" ? totalTokenUsage["inputTokens"]
      : typeof totalTokenUsage["input_tokens"] === "number" ? totalTokenUsage["input_tokens"] : 0
    const output = typeof totalTokenUsage["outputTokens"] === "number" ? totalTokenUsage["outputTokens"]
      : typeof totalTokenUsage["output_tokens"] === "number" ? totalTokenUsage["output_tokens"] : 0
    const total = typeof totalTokenUsage["totalTokens"] === "number" ? totalTokenUsage["totalTokens"]
      : typeof totalTokenUsage["total_tokens"] === "number" ? totalTokenUsage["total_tokens"] : input + output
    return { type: "token_usage", input, output, total }
  }

  return null
}

const needsInput = (method: string, payload: Record<string, unknown>): boolean => {
  const inputMethods = [
    "turn/input_required", "turn/needs_input", "turn/need_input",
    "turn/request_input", "turn/request_response", "turn/provide_input",
    "turn/approval_required",
  ]
  if (inputMethods.includes(method)) return true

  const params = payload["params"] as Record<string, unknown> | undefined
  return hasInputFlag(payload) || hasInputFlag(params)
}

const hasInputFlag = (obj: Record<string, unknown> | undefined | null): boolean => {
  if (!obj) return false
  return (
    obj["requiresInput"] === true ||
    obj["needsInput"] === true ||
    obj["input_required"] === true ||
    obj["inputRequired"] === true ||
    obj["type"] === "input_required" ||
    obj["type"] === "needs_input"
  )
}
