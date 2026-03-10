import type { ResolvedConfig } from "../types.js"
import { ConfigError } from "../types.js"

export function validateDispatchConfig(config: ResolvedConfig): ConfigError[] {
  const errors: ConfigError[] = []

  if (!config.tracker.kind || config.tracker.kind !== "linear") {
    errors.push(new ConfigError({
      code: "unsupported_tracker_kind",
      message: `Unsupported tracker kind: "${config.tracker.kind}". Only "linear" is supported.`,
    }))
  }
  if (!config.tracker.api_key) {
    errors.push(new ConfigError({
      code: "missing_tracker_api_key",
      message:
        'tracker.api_key is required. Set LINEAR_API_KEY env var or configure tracker.api_key in WORKFLOW.md.',
    }))
  }
  if (!config.tracker.project_slug) {
    errors.push(new ConfigError({
      code: "missing_tracker_project_slug",
      message: "tracker.project_slug is required in WORKFLOW.md.",
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

  return errors
}
