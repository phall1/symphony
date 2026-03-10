import { Effect, Layer } from "effect"
import { mkdir, realpath, rm } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { runHookScript } from "./hooks.js"
import { WorkspaceManager, WorkflowStore } from "../services.js"
import type { Workspace, ResolvedConfig } from "../types.js"
import { WorkspaceError } from "../types.js"

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_")
}

export function workspacePath(root: string, identifier: string): string {
  const key = sanitizeWorkspaceKey(identifier)
  return join(root, key)
}

export function assertPathContainment(root: string, wsPath: string): Effect.Effect<void, WorkspaceError> {
  return Effect.tryPromise({
    try: async () => {
      let resolvedRoot: string
      let resolvedWs: string
      try { resolvedRoot = await realpath(root) } catch { resolvedRoot = resolve(root) }
      try { resolvedWs = await realpath(wsPath) } catch { resolvedWs = resolve(wsPath) }

      if (!resolvedWs.startsWith(resolvedRoot + sep) && resolvedWs !== resolvedRoot) {
        throw new WorkspaceError({
          code: "path_containment_violation",
          message: `Workspace path "${resolvedWs}" is not contained within root "${resolvedRoot}"`,
        })
      }
    },
    catch: (error) => {
      if (error instanceof WorkspaceError) return error
      return new WorkspaceError({ code: "path_containment_violation", message: String(error) })
    }
  })
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
      catch: (error) => new WorkspaceError({
        code: "workspace_creation_failed",
        message: `Failed to create workspace directory: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      })
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
      yield* Effect.catch(
        runHookScript(hooks.before_remove, wsPath, hooks.timeout_ms),
        () => Effect.logWarning(`[WorkspaceManager] before_remove hook failed for ${identifier}, continuing`)
      )
    }

    yield* Effect.tryPromise({
      try: async () => {
        await rm(wsPath, { recursive: true, force: true })
      },
      catch: (error) => new WorkspaceError({
        code: "workspace_creation_failed",
        message: `Failed to remove workspace: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      })
    })
  })
}

function makeWorkspaceManagerService(config: ResolvedConfig): WorkspaceManager["Service"] {
  const { root } = config.workspace
  const { hooks } = config

  return {
    createForIssue: (identifier: string) =>
      createWorkspace(root, identifier, hooks),

    removeForIssue: (identifier: string) =>
      removeWorkspace(root, identifier, hooks),

    runHook: (hook: "before_run" | "after_run" | "before_remove", wsPath: string) => {
      if (hook === "before_run") {
        const script = hooks.before_run
        if (!script) return Effect.void
        return runHookScript(script, wsPath, hooks.timeout_ms)
      }

      const script = hook === "after_run" ? hooks.after_run : hooks.before_remove
      if (!script) return Effect.void
      return Effect.catch(
        runHookScript(script, wsPath, hooks.timeout_ms),
        () => Effect.logWarning(`[WorkspaceManager] ${hook} hook failed for ${wsPath}, ignoring`)
      )
    },
  }
}

export function makeWorkspaceManagerLive(config: ResolvedConfig): Layer.Layer<WorkspaceManager> {
  return Layer.succeed(WorkspaceManager, makeWorkspaceManagerService(config))
}

export const WorkspaceManagerLive: Layer.Layer<WorkspaceManager, never, WorkflowStore> = Layer.effect(
  WorkspaceManager
)(
  Effect.gen(function* () {
    const store = yield* WorkflowStore
    const config = yield* Effect.orDie(store.getResolved())
    return makeWorkspaceManagerService(config)
  })
)
