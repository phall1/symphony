import { Effect } from "effect"
import { spawn } from "node:child_process"
import { WorkspaceError } from "../types.js"

export function runHookScript(
  script: string,
  cwd: string,
  timeoutMs: number
): Effect.Effect<void, WorkspaceError> {
  return Effect.callback<void, WorkspaceError>((resume) => {
    const proc = spawn("bash", ["-lc", script], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
      resume(Effect.fail(new WorkspaceError({
        code: "hook_timeout",
        message: `Hook timed out after ${timeoutMs}ms: ${script.slice(0, 100)}`,
      })))
    }, timeoutMs)

    proc.on("close", (code) => {
      clearTimeout(timer)
      if (timedOut) return
      if (code === 0) {
        resume(Effect.void)
      } else {
        resume(Effect.fail(new WorkspaceError({
          code: "hook_failed",
          message: `Hook exited with code ${code}: ${script.slice(0, 100)}`,
        })))
      }
    })

    proc.on("error", (error) => {
      clearTimeout(timer)
      if (timedOut) return
      resume(Effect.fail(new WorkspaceError({
        code: "hook_failed",
        message: `Hook process error: ${error.message}`,
        cause: error,
      })))
    })
  })
}
