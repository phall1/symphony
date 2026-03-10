import { describe, it, expect, afterEach } from "vitest"
import { Effect, Result } from "effect"
import { mkdtemp, rm, realpath } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  sanitizeWorkspaceKey,
  assertPathContainment,
  workspacePath,
  makeWorkspaceManagerLive,
} from "./index.js"
import { runHookScript } from "./hooks.js"

let tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "symphony-test-"))
  const resolvedDir = await realpath(dir)
  tempDirs.push(resolvedDir)
  return resolvedDir
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe("sanitizeWorkspaceKey", () => {
  it("leaves MT-123 unchanged", () => {
    expect(sanitizeWorkspaceKey("MT-123")).toBe("MT-123")
  })

  it("replaces slash in ABC/DEF", () => {
    expect(sanitizeWorkspaceKey("ABC/DEF")).toBe("ABC_DEF")
  })

  it("replaces space in FOO BAR", () => {
    expect(sanitizeWorkspaceKey("FOO BAR")).toBe("FOO_BAR")
  })
})

describe("assertPathContainment", () => {
  it("fails with path_containment_violation for path outside root", async () => {
    const root = "/tmp/safe-root"
    const outside = "/tmp/other-dir"
    const result = await Effect.runPromise(
      Effect.result(assertPathContainment(root, outside))
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.code).toBe("path_containment_violation")
    }
  })

  it("succeeds for path inside root", async () => {
    const root = "/tmp/safe-root"
    const inside = "/tmp/safe-root/sub/dir"
    await expect(
      Effect.runPromise(assertPathContainment(root, inside))
    ).resolves.toBeUndefined()
  })
})

describe("createWorkspace", () => {
  it("sets created_now=true for new directory", async () => {
    const root = await makeTempDir()
    const layer = makeWorkspaceManagerLive({
      tracker: { kind: "linear", endpoint: "", api_key: "", project_slug: "", active_states: [], terminal_states: [], assignee: null },
      polling: { interval_ms: 30000 },
      workspace: { root },
      hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 30000 },
      agent: { max_concurrent_agents: 1, max_turns: 10, max_retry_backoff_ms: 5000, max_concurrent_agents_by_state: {}, engine: "codex" },
      codex: { command: "codex", approval_policy: null, thread_sandbox: "", turn_sandbox_policy: null, turn_timeout_ms: 60000, read_timeout_ms: 30000, stall_timeout_ms: 30000 },
      opencode: { mode: "per-workspace", server_url: null, model: "gpt-4o", agent: "opencode", port: 3000 },
      server: { port: null, host: "127.0.0.1" },
    })

    const { WorkspaceManager } = await import("../services.js")
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* WorkspaceManager
          return yield* svc.createForIssue("MT-001")
        }),
        layer
      )
    )
    expect(result.created_now).toBe(true)
    expect(result.workspace_key).toBe("MT-001")
  })

  it("sets created_now=false for existing directory", async () => {
    const root = await makeTempDir()
    const layer = makeWorkspaceManagerLive({
      tracker: { kind: "linear", endpoint: "", api_key: "", project_slug: "", active_states: [], terminal_states: [], assignee: null },
      polling: { interval_ms: 30000 },
      workspace: { root },
      hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 30000 },
      agent: { max_concurrent_agents: 1, max_turns: 10, max_retry_backoff_ms: 5000, max_concurrent_agents_by_state: {}, engine: "codex" },
      codex: { command: "codex", approval_policy: null, thread_sandbox: "", turn_sandbox_policy: null, turn_timeout_ms: 60000, read_timeout_ms: 30000, stall_timeout_ms: 30000 },
      opencode: { mode: "per-workspace", server_url: null, model: "gpt-4o", agent: "opencode", port: 3000 },
      server: { port: null, host: "127.0.0.1" },
    })

    const { WorkspaceManager } = await import("../services.js")
    const run = Effect.provide(
      Effect.gen(function* () {
        const svc = yield* WorkspaceManager
        return yield* svc.createForIssue("MT-002")
      }),
      layer
    )

    await Effect.runPromise(run)
    const second = await Effect.runPromise(run)
    expect(second.created_now).toBe(false)
  })
})

describe("hook execution", () => {
  it("after_create hook failure propagates as WorkspaceError", async () => {
    const root = await makeTempDir()
    const layer = makeWorkspaceManagerLive({
      tracker: { kind: "linear", endpoint: "", api_key: "", project_slug: "", active_states: [], terminal_states: [], assignee: null },
      polling: { interval_ms: 30000 },
      workspace: { root },
      hooks: { after_create: "exit 1", before_run: null, after_run: null, before_remove: null, timeout_ms: 5000 },
      agent: { max_concurrent_agents: 1, max_turns: 10, max_retry_backoff_ms: 5000, max_concurrent_agents_by_state: {}, engine: "codex" },
      codex: { command: "codex", approval_policy: null, thread_sandbox: "", turn_sandbox_policy: null, turn_timeout_ms: 60000, read_timeout_ms: 30000, stall_timeout_ms: 30000 },
      opencode: { mode: "per-workspace", server_url: null, model: "gpt-4o", agent: "opencode", port: 3000 },
      server: { port: null, host: "127.0.0.1" },
    })

    const { WorkspaceManager } = await import("../services.js")
    const result = await Effect.runPromise(
      Effect.result(
        Effect.provide(
          Effect.gen(function* () {
            const svc = yield* WorkspaceManager
            return yield* svc.createForIssue("MT-003")
          }),
          layer
        )
      )
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.code).toBe("hook_failed")
    }
  })

  it("after_run hook failure does NOT propagate (best-effort)", async () => {
    const root = await makeTempDir()
    const layer = makeWorkspaceManagerLive({
      tracker: { kind: "linear", endpoint: "", api_key: "", project_slug: "", active_states: [], terminal_states: [], assignee: null },
      polling: { interval_ms: 30000 },
      workspace: { root },
      hooks: { after_create: null, before_run: null, after_run: "exit 1", before_remove: null, timeout_ms: 5000 },
      agent: { max_concurrent_agents: 1, max_turns: 10, max_retry_backoff_ms: 5000, max_concurrent_agents_by_state: {}, engine: "codex" },
      codex: { command: "codex", approval_policy: null, thread_sandbox: "", turn_sandbox_policy: null, turn_timeout_ms: 60000, read_timeout_ms: 30000, stall_timeout_ms: 30000 },
      opencode: { mode: "per-workspace", server_url: null, model: "gpt-4o", agent: "opencode", port: 3000 },
      server: { port: null, host: "127.0.0.1" },
    })

    const { WorkspaceManager } = await import("../services.js")
    await expect(
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const svc = yield* WorkspaceManager
            return yield* svc.runHook("after_run", root)
          }),
          layer
        )
      )
    ).resolves.toBeUndefined()
  })

  it("runHookScript succeeds with exit 0", async () => {
    const dir = await makeTempDir()
    await expect(
      Effect.runPromise(runHookScript("exit 0", dir, 5000))
    ).resolves.toBeUndefined()
  })

  it("runHookScript fails with WorkspaceError on exit 1", async () => {
    const dir = await makeTempDir()
    const result = await Effect.runPromise(
      Effect.result(runHookScript("exit 1", dir, 5000))
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("WorkspaceError")
      expect(result.failure.code).toBe("hook_failed")
    }
  })

  it("before_remove hook failure does not propagate (§17.2 before_remove best-effort)", async () => {
    const root = await makeTempDir()
    const layer = makeWorkspaceManagerLive({
      tracker: { kind: "linear", endpoint: "", api_key: "", project_slug: "", active_states: [], terminal_states: [], assignee: null },
      polling: { interval_ms: 30000 },
      workspace: { root },
      hooks: { after_create: null, before_run: null, after_run: null, before_remove: "exit 1", timeout_ms: 5000 },
      agent: { max_concurrent_agents: 1, max_turns: 10, max_retry_backoff_ms: 5000, max_concurrent_agents_by_state: {}, engine: "codex" },
      codex: { command: "codex", approval_policy: null, thread_sandbox: "", turn_sandbox_policy: null, turn_timeout_ms: 60000, read_timeout_ms: 30000, stall_timeout_ms: 30000 },
      opencode: { mode: "per-workspace", server_url: null, model: "gpt-4o", agent: "opencode", port: 3000 },
      server: { port: null, host: "127.0.0.1" },
    })

    const { WorkspaceManager } = await import("../services.js")
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* WorkspaceManager
          yield* svc.createForIssue("MT-BR-001")
        }),
        layer
      )
    )
    await expect(
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const svc = yield* WorkspaceManager
            yield* svc.removeForIssue("MT-BR-001")
          }),
          layer
        )
      )
    ).resolves.toBeUndefined()
  })
})

describe("workspacePath", () => {
  it("produces the same path for the same identifier (§17.2 deterministic)", () => {
    const root = "/tmp/test-root"
    const p1 = workspacePath(root, "MT-001")
    const p2 = workspacePath(root, "MT-001")
    expect(p1).toBe(p2)
  })

  it("produces different paths for different identifiers (§17.2 deterministic)", () => {
    const root = "/tmp/test-root"
    expect(workspacePath(root, "MT-001")).not.toBe(workspacePath(root, "MT-002"))
  })

  it("workspace path uses sanitized identifier under root (§17.2 agent cwd)", async () => {
    const root = await makeTempDir()
    const layer = makeWorkspaceManagerLive({
      tracker: { kind: "linear", endpoint: "", api_key: "", project_slug: "", active_states: [], terminal_states: [], assignee: null },
      polling: { interval_ms: 30000 },
      workspace: { root },
      hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 30000 },
      agent: { max_concurrent_agents: 1, max_turns: 10, max_retry_backoff_ms: 5000, max_concurrent_agents_by_state: {}, engine: "codex" },
      codex: { command: "codex", approval_policy: null, thread_sandbox: "", turn_sandbox_policy: null, turn_timeout_ms: 60000, read_timeout_ms: 30000, stall_timeout_ms: 30000 },
      opencode: { mode: "per-workspace", server_url: null, model: "gpt-4o", agent: "opencode", port: 3000 },
      server: { port: null, host: "127.0.0.1" },
    })

    const { WorkspaceManager } = await import("../services.js")
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* WorkspaceManager
          return yield* svc.createForIssue("MT-CWD-001")
        }),
        layer
      )
    )
    expect(result.path).toBe(join(root, "MT-CWD-001"))
    expect(result.workspace_key).toBe("MT-CWD-001")
  })
})
