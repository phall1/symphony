import { Effect, Stream, Queue } from "effect"
import type { AgentEvent, TokenUsage } from "../../types.js"
import type { AgentSessionError } from "../agent.js"
import type { CodexProtocol } from "./protocol.js"

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
): Stream.Stream<AgentEvent, AgentSessionError> => {
  const processNextLine: Effect.Effect<
    AgentEvent | null,
    AgentSessionError
  > = Effect.gen(function* () {
    const line = yield* Queue.take(lineQueue).pipe(
      Effect.timeout(turnTimeoutMs),
      Effect.catchCause(() =>
        Effect.fail<AgentSessionError>({
          _tag: "AgentSessionError",
          message: "turn_timeout: no message within turn_timeout_ms",
        }),
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

    return yield* mapProtocolMessage(method, parsed, protocol)
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
): Effect.Effect<AgentEvent | null, AgentSessionError> =>
  Effect.gen(function* () {
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

    // User input required — hard fail
    if (INPUT_REQUIRED_METHODS.has(method)) {
      return yield* Effect.fail<AgentSessionError>({
        _tag: "AgentSessionError",
        message: "turn_input_required: agent requested user input",
        cause: payload,
      })
    }

    // Tool calls — unsupported tool response
    if (method === "item/tool/call") {
      const id = payload["id"]
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
      return yield* Effect.fail<AgentSessionError>({
        _tag: "AgentSessionError",
        message: "turn_input_required: agent requested user input",
        cause: payload,
      })
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
  const params = payload["params"] as Record<string, unknown> | undefined
  const usage = params?.["usage"] as Record<string, unknown> | undefined
  if (!usage) return null
  const input = typeof usage["inputTokens"] === "number" ? usage["inputTokens"]
    : typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0
  const output = typeof usage["outputTokens"] === "number" ? usage["outputTokens"]
    : typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0
  const total = typeof usage["totalTokens"] === "number" ? usage["totalTokens"]
    : typeof usage["total_tokens"] === "number" ? usage["total_tokens"] : input + output
  return { type: "token_usage", input, output, total }
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
