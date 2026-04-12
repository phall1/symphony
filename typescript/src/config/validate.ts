import type { ResolvedConfig } from "../types.js"
import { ConfigError } from "../types.js"

export function validateDispatchConfig(config: ResolvedConfig): ConfigError[] {
  const errors: ConfigError[] = []

  if (!config.tracker.kind || !["linear", "plane"].includes(config.tracker.kind)) {
    errors.push(new ConfigError({
      code: "unsupported_tracker_kind",
      message: `Unsupported tracker kind: "${config.tracker.kind}". Supported values are "linear" and "plane".`,
    }))
  }
  if (!config.tracker.api_key) {
    errors.push(new ConfigError({
      code: "missing_tracker_api_key",
      message:
        'tracker.api_key is required. Set LINEAR_API_KEY / PLANE_API_KEY env var or configure tracker.api_key in WORKFLOW.md.',
    }))
  }
  if (config.tracker.kind === "linear" && !config.tracker.project_slug) {
    errors.push(new ConfigError({
      code: "missing_tracker_project_slug",
      message: "tracker.project_slug is required when tracker.kind is \"linear\".",
    }))
  }
  if (config.tracker.kind === "plane" && !config.tracker.workspace_slug) {
    errors.push(new ConfigError({
      code: "missing_tracker_workspace_slug",
      message: "tracker.workspace_slug is required when tracker.kind is \"plane\".",
    }))
  }
  if (config.tracker.kind === "plane" && !config.tracker.project_id) {
    errors.push(new ConfigError({
      code: "missing_tracker_project_id",
      message: "tracker.project_id is required when tracker.kind is \"plane\".",
    }))
  }
  if (!config.codex.command) {
    errors.push(new ConfigError({
      code: "missing_codex_command",
      message: "codex.command is required.",
    }))
  }

  if (config.agent.engine === "codex") {
    const ap = config.codex.approval_policy
    if (ap === null || ap === undefined) {
      errors.push(new ConfigError({ code: "invalid_config", message: "codex.approval_policy is required" }))
    }
    if (!config.codex.thread_sandbox) {
      errors.push(new ConfigError({ code: "invalid_config", message: "codex.thread_sandbox must be a non-empty string" }))
    }
    const tsp = config.codex.turn_sandbox_policy
    if (tsp === null || tsp === undefined) {
      errors.push(new ConfigError({ code: "invalid_config", message: "codex.turn_sandbox_policy is required" }))
    }
  }

  if (config.agent.engine === "opencode") {
    if (!config.opencode.agent || config.opencode.agent.trim().length === 0) {
      errors.push(new ConfigError({
        code: "invalid_config",
        message: "opencode.agent is required when agent.engine is \"opencode\"",
      }))
    }
    if (config.opencode.mode === "shared" && (!config.opencode.server_url || config.opencode.server_url.trim().length === 0)) {
      errors.push(new ConfigError({
        code: "invalid_config",
        message: "opencode.server_url is required when opencode.mode is \"shared\"",
      }))
    }
  }

  return errors
}
