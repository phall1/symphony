import { Effect, Ref } from "effect"
import type { AgentEngineError } from "../agent.js"
import type { ResolvedConfig } from "../../types.js"
import type { CodexProtocol } from "./protocol.js"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HandshakeResult {
  readonly threadId: string
  readonly turnId: string
  readonly sessionId: string
}

// ─── Handshake ────────────────────────────────────────────────────────────────

/**
 * JSON-RPC startup handshake sequence (SPEC §10.2):
 * initialize → initialized → thread/start → turn/start
 */
export const performHandshake = (
  protocol: CodexProtocol,
  workspace: string,
  prompt: string,
  title: string,
  config: ResolvedConfig["codex"],
): Effect.Effect<HandshakeResult, AgentEngineError> =>
  Effect.gen(function* () {
    const approvalPolicy = config.approval_policy ?? {
      reject: { sandbox_approval: true, rules: true, mcp_elicitations: true },
    }
    const threadSandbox = config.thread_sandbox || "workspace-write"
    const turnSandboxPolicy = config.turn_sandbox_policy ?? {
      type: "workspaceWrite",
      workspacePath: workspace,
    }

    // Step 1: initialize
    const initResult = yield* protocol.sendRequest("initialize", {
      clientInfo: { name: "symphony", version: "1.0" },
      capabilities: {},
    })

    // Step 2: initialized notification
    yield* protocol.sendNotification("initialized", {})

    // Step 3: thread/start
    const threadResult = yield* protocol.sendRequest("thread/start", {
      approvalPolicy,
      sandbox: threadSandbox,
      cwd: workspace,
    })

    const threadPayload = threadResult["thread"] as Record<string, unknown> | undefined
    if (!threadPayload || typeof threadPayload["id"] !== "string") {
      return yield* Effect.fail<AgentEngineError>({
        _tag: "AgentEngineError",
        message: "Invalid thread/start response: missing thread.id",
        cause: threadResult,
      })
    }
    const threadId = threadPayload["id"] as string

    // Step 4: turn/start
    const turnResult = yield* protocol.sendRequest("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd: workspace,
      title,
      approvalPolicy,
      sandboxPolicy: turnSandboxPolicy,
    })

    const turnPayload = turnResult["turn"] as Record<string, unknown> | undefined
    if (!turnPayload || typeof turnPayload["id"] !== "string") {
      return yield* Effect.fail<AgentEngineError>({
        _tag: "AgentEngineError",
        message: "Invalid turn/start response: missing turn.id",
        cause: turnResult,
      })
    }
    const turnId = turnPayload["id"] as string

    return { threadId, turnId, sessionId: `${threadId}-${turnId}` } satisfies HandshakeResult
  })
