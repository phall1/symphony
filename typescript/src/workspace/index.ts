import { Effect, Layer } from "effect"
import { mkdir, rm } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { runHookScript } from "./hooks.js"
import { WorkspaceManager } from "../services.js"
import type { Workspace, WorkspaceError, ResolvedConfig } from "../types.js"

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_")
}

export function workspacePath(root: string, identifier: string): string {
  const key = sanitizeWorkspaceKey(identifier)
  return join(root, key)
}

/** SPEC.md §9.5 Invariant 2: workspace path must be contained within root */
export function assertPathContainment(root: string, wsPath: string): Effect.Effect<void, WorkspaceError> {
  const resolvedRoot = resolve(root)
  const resolvedWs = resolve(wsPath)
  if (!resolvedWs.startsWith(resolvedRoot + sep) && resolvedWs !== resolvedRoot) {
    return Effect.fail({
      _tag: "WorkspaceError" as const,
      code: "path_containment_violation" as const,
      message: `Workspace path "${resolvedWs}" is not contained within root "${resolvedRoot}"`,
    })
  }
  return Effect.void
}

function createWorkspace(
  root: string,
  identifier: string,
  hooks: ResolvedConfig["hooks"]
): Effect.Effect<Workspace, WorkspaceError> {
  return Effect.gen(function* () {
    const key = sanitizeWorkspaceKey(identifier)
    const wsPath = join(root, key)

    yield* assertPathContainment(root, wsPath)

    let created_now = false
    yield* Effect.tryPromise({
      try: async () => {
        // mkdir({recursive:true}) returns the path when newly created, undefined when it already exists
        const result = await mkdir(wsPath, { recursive: true })
        created_now = result !== undefined
      },
      catch: (error) => ({
        _tag: "WorkspaceError" as const,
        code: "workspace_creation_failed" as const,
        message: `Failed to create workspace directory: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      } satisfies WorkspaceError)
    })

    if (created_now && hooks.after_create) {
      yield* runHookScript(hooks.after_create, wsPath, hooks.timeout_ms)
    }

    return { path: wsPath, workspace_key: key, created_now } satisfies Workspace
  })
}

function removeWorkspace(
  root: string,
  identifier: string,
  hooks: ResolvedConfig["hooks"]
): Effect.Effect<void, WorkspaceError> {
  return Effect.gen(function* () {
    const key = sanitizeWorkspaceKey(identifier)
    const wsPath = join(root, key)

    yield* assertPathContainment(root, wsPath)

    if (hooks.before_remove) {
      yield* Effect.catchCause(
        runHookScript(hooks.before_remove, wsPath, hooks.timeout_ms),
        () => Effect.sync(() => {
          process.stderr.write(`[WorkspaceManager] before_remove hook failed for ${identifier}, continuing\n`)
        })
      )
    }

    yield* Effect.tryPromise({
      try: async () => {
        await rm(wsPath, { recursive: true, force: true })
      },
      catch: (error) => ({
        _tag: "WorkspaceError" as const,
        code: "workspace_creation_failed" as const,
        message: `Failed to remove workspace: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      } satisfies WorkspaceError)
    })
  })
}

export function makeWorkspaceManagerLive(config: ResolvedConfig): Layer.Layer<WorkspaceManager> {
  const { root } = config.workspace
  const { hooks } = config

  return Layer.succeed(WorkspaceManager, {
    createForIssue: (identifier: string) =>
      createWorkspace(root, identifier, hooks),

    removeForIssue: (identifier: string) =>
      removeWorkspace(root, identifier, hooks),

    runHook: (hook: "after_run" | "before_remove", wsPath: string) => {
      const script = hook === "after_run" ? hooks.after_run : hooks.before_remove
      if (!script) return Effect.void
      return Effect.catchCause(
        runHookScript(script, wsPath, hooks.timeout_ms),
        () => Effect.sync(() => {
          process.stderr.write(`[WorkspaceManager] ${hook} hook failed for ${wsPath}, ignoring\n`)
        })
      )
    },
  })
}
