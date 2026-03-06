import type { ResolvedConfig, ConfigError } from "../types.js"

export function validateDispatchConfig(config: ResolvedConfig): ConfigError[] {
  const errors: ConfigError[] = []

  if (!config.tracker.kind || config.tracker.kind !== "linear") {
    errors.push({
      _tag: "ConfigError",
      code: "unsupported_tracker_kind",
      message: `Unsupported tracker kind: "${config.tracker.kind}". Only "linear" is supported.`,
    })
  }
  if (!config.tracker.api_key) {
    errors.push({
      _tag: "ConfigError",
      code: "missing_tracker_api_key",
      message:
        'tracker.api_key is required. Set LINEAR_API_KEY env var or configure tracker.api_key in WORKFLOW.md.',
    })
  }
  if (!config.tracker.project_slug) {
    errors.push({
      _tag: "ConfigError",
      code: "missing_tracker_project_slug",
      message: "tracker.project_slug is required in WORKFLOW.md.",
    })
  }
  if (!config.codex.command) {
    errors.push({
      _tag: "ConfigError",
      code: "missing_codex_command",
      message: "codex.command is required.",
    })
  }

  return errors
}
