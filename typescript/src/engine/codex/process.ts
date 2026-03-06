import { Effect, Scope, Stream } from "effect"
import type { ResolvedConfig } from "../../types.js"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CodexProcess {
  readonly write: (msg: string) => Effect.Effect<void>
  readonly lines: Stream.Stream<string, Error>
  readonly pid: number
  readonly kill: () => Effect.Effect<void>
  readonly exitCode: Effect.Effect<number>
}

const MAX_LINE_SIZE = 10 * 1024 * 1024

// ─── Launch ───────────────────────────────────────────────────────────────────

/**
 * Spawn a Codex app-server subprocess scoped to the current Effect Scope.
 * Uses `bash -lc <command>` per SPEC §10.1.
 * Uses Bun.spawn() directly to avoid ChildProcessSpawner service dependency.
 */
export const launchCodexProcess = (
  workspace: string,
  config: ResolvedConfig["codex"],
): Effect.Effect<CodexProcess, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const command = config.command || "codex app-server"

    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd: workspace,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    const pid = proc.pid

    const write = (msg: string): Effect.Effect<void> =>
      Effect.sync(() => {
        const line = msg.endsWith("\n") ? msg : msg + "\n"
        const bytes = new TextEncoder().encode(line)
        proc.stdin.write(bytes)
        proc.stdin.flush()
      })

    const stdoutStream: Stream.Stream<Uint8Array, Error> = Stream.fromReadableStream({
      evaluate: () => proc.stdout as ReadableStream<Uint8Array>,
      onError: (err) => (err instanceof Error ? err : new Error(String(err))),
    })

    const lines = splitIntoLines(stdoutStream)

    // Log stderr as diagnostics only — never parse as protocol (SPEC §10.3)
    const stderrStream: Stream.Stream<Uint8Array, Error> = Stream.fromReadableStream({
      evaluate: () => proc.stderr as ReadableStream<Uint8Array>,
      onError: (err) => (err instanceof Error ? err : new Error(String(err))),
    })

    yield* Effect.forkChild(
      Stream.runForEach(stderrStream, (chunk) => {
        const text = new TextDecoder().decode(chunk).trim()
        if (text.length > 0) {
          return Effect.logDebug("codex stderr").pipe(
            Effect.annotateLogs("stderr", text.slice(0, 1000)),
          )
        }
        return Effect.void
      }).pipe(Effect.catchCause(() => Effect.void)),
    )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        proc.kill()
      }),
    )

    const kill = (): Effect.Effect<void> => Effect.sync(() => proc.kill())

    const exitCode: Effect.Effect<number> = Effect.promise(() => proc.exited)

    return { write, lines, pid, kill, exitCode } satisfies CodexProcess
  })

// ─── Line Splitting ─────────────────────────────────────────────────────────

/** Stateful line splitter: buffers partial lines, emits on \n, enforces MAX_LINE_SIZE */
export const splitIntoLines = <E, R>(
  source: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<string, E, R> => {
  const decoder = new TextDecoder()

  return Stream.suspend(() => {
    let buffer = ""

    return source.pipe(
      Stream.flatMap((chunk) => {
        buffer += decoder.decode(chunk, { stream: true })
        const parts = buffer.split("\n")
        buffer = parts.pop() ?? ""

        if (buffer.length > MAX_LINE_SIZE) {
          buffer = ""
        }

        return Stream.fromIterable(parts.filter((line) => line.length > 0))
      }),
    )
  })
}
