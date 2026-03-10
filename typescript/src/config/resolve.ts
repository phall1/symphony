import { homedir, tmpdir } from "node:os"
import type {
  WorkflowConfig,
  ResolvedConfig,
  TrackerConfig,
  PollingConfig,
  WorkspaceConfig,
  HooksConfig,
  AgentConfig,
  CodexConfig,
  OpenCodeConfig,
  ServerConfig,
} from "../types.js"

const DEFAULTS = {
  tracker: {
    endpoint: "https://api.linear.app/graphql",
    active_states: ["Todo", "In Progress"],
    terminal_states: ["Done", "Cancelled", "Canceled", "Duplicate", "Closed"],
  },
  polling: { interval_ms: 30000 },
  workspace: { root: `${tmpdir()}/symphony_workspaces` },
  hooks: { timeout_ms: 60000 },
  agent: {
    max_concurrent_agents: 10,
    max_turns: 20,
    max_retry_backoff_ms: 300000,
    engine: "codex" as const,
  },
  codex: {
    command: "codex app-server",
    approval_policy: { reject: { sandbox_approval: true, rules: true, mcp_elicitations: true } },
    thread_sandbox: "workspace-write",
    turn_sandbox_policy: { type: "workspaceWrite" },
    turn_timeout_ms: 3600000,
    read_timeout_ms: 5000,
    stall_timeout_ms: 300000,
  },
  opencode: {
    mode: "per-workspace" as const,
    server_url: null as string | null,
    model: "anthropic/claude-sonnet-4-20250514",
    agent: "build",
    port: 0,
  },
}

function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return value
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value)
  if (match) {
    const key = match[1] as string
    const envVal = process.env[key]
    return envVal === "" || envVal === undefined ? undefined : envVal
  }
  return value
}

function expandPath(value: string | undefined): string | undefined {
  if (!value) return value
  const envResolved = resolveEnvVar(value)
  if (!envResolved) return envResolved
  if (envResolved.startsWith("~")) {
    return homedir() + envResolved.slice(1)
  }
  return envResolved
}

function parseStates(
  value: ReadonlyArray<string> | string | undefined,
  defaults: string[]
): string[] {
  if (!value) return defaults
  if (Array.isArray(value)) return (value as string[]).map((s: string) => s.trim()).filter(Boolean)
  return (value as string).split(",").map((s: string) => s.trim()).filter(Boolean)
}

function parsePositiveInt(value: number | string | undefined, defaultVal: number): number {
  if (value === undefined || value === null) return defaultVal
  const n = typeof value === "string" ? parseInt(value, 10) : value
  return isNaN(n) || n <= 0 ? defaultVal : n
}

export function resolveConfig(config: WorkflowConfig): ResolvedConfig {
  const t: TrackerConfig = config.tracker ?? {}
  const p: PollingConfig = config.polling ?? {}
  const w: WorkspaceConfig = config.workspace ?? {}
  const h: HooksConfig = config.hooks ?? {}
  const a: AgentConfig = config.agent ?? {}
  const c: CodexConfig = config.codex ?? {}
  const o: OpenCodeConfig = config.opencode ?? {}
  const s: ServerConfig = config.server ?? {}

  const rawApiKey = t.api_key ?? "$LINEAR_API_KEY"
  const resolvedApiKey = resolveEnvVar(rawApiKey) ?? ""

  const byState: Record<string, number> = {}
  if (a.max_concurrent_agents_by_state) {
    for (const [key, val] of Object.entries(a.max_concurrent_agents_by_state)) {
      const normalized = key.trim().toLowerCase()
      const n = typeof val === "number" ? val : parseInt(String(val), 10)
      if (!isNaN(n) && n > 0) {
        byState[normalized] = n
      }
    }
  }

  return {
    tracker: {
      kind: t.kind ?? "",
      endpoint: t.endpoint ?? DEFAULTS.tracker.endpoint,
      api_key: resolvedApiKey,
      project_slug: t.project_slug ?? "",
      active_states: parseStates(t.active_states, DEFAULTS.tracker.active_states),
      terminal_states: parseStates(t.terminal_states, DEFAULTS.tracker.terminal_states),
      assignee: t.assignee?.trim() || null,
    },
    polling: {
      interval_ms: parsePositiveInt(p.interval_ms, DEFAULTS.polling.interval_ms),
    },
    workspace: {
      root: expandPath(w.root) ?? DEFAULTS.workspace.root,
    },
    hooks: {
      after_create: h.after_create ?? null,
      before_run: h.before_run ?? null,
      after_run: h.after_run ?? null,
      before_remove: h.before_remove ?? null,
      timeout_ms: parsePositiveInt(h.timeout_ms, DEFAULTS.hooks.timeout_ms),
    },
    agent: {
      max_concurrent_agents: parsePositiveInt(a.max_concurrent_agents, DEFAULTS.agent.max_concurrent_agents),
      max_turns: parsePositiveInt(a.max_turns, DEFAULTS.agent.max_turns),
      max_retry_backoff_ms: parsePositiveInt(a.max_retry_backoff_ms, DEFAULTS.agent.max_retry_backoff_ms),
      max_concurrent_agents_by_state: byState,
      engine: (a.engine ?? DEFAULTS.agent.engine) as "codex" | "opencode",
    },
    codex: {
      command: c.command ?? DEFAULTS.codex.command,
      approval_policy: c.approval_policy ?? DEFAULTS.codex.approval_policy,
      thread_sandbox: (c.thread_sandbox as string | undefined) ?? DEFAULTS.codex.thread_sandbox,
      turn_sandbox_policy: c.turn_sandbox_policy ?? DEFAULTS.codex.turn_sandbox_policy,
      turn_timeout_ms: c.turn_timeout_ms ?? DEFAULTS.codex.turn_timeout_ms,
      read_timeout_ms: c.read_timeout_ms ?? DEFAULTS.codex.read_timeout_ms,
      stall_timeout_ms: c.stall_timeout_ms ?? DEFAULTS.codex.stall_timeout_ms,
    },
    opencode: {
      mode: (o.mode ?? DEFAULTS.opencode.mode) as "per-workspace" | "shared",
      server_url: o.server_url ?? DEFAULTS.opencode.server_url,
      model: o.model ?? DEFAULTS.opencode.model,
      agent: o.agent ?? DEFAULTS.opencode.agent,
      port: o.port ?? DEFAULTS.opencode.port,
    },
    server: {
      port: s.port ?? null,
      host: s.host ?? "127.0.0.1",
    },
  }
}
