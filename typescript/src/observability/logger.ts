import { Cause, Effect, Layer, Logger, References } from "effect"
import type { LogLevel } from "effect"

// ─── Log Level from env ────────────────────────────────────────────────────────

function resolveLogLevel(): LogLevel.LogLevel {
  const raw = process.env["LOG_LEVEL"]?.toLowerCase()
  switch (raw) {
    case "trace":
      return "Trace"
    case "debug":
      return "Debug"
    case "info":
      return "Info"
    case "warning":
    case "warn":
      return "Warn"
    case "error":
      return "Error"
    case "fatal":
      return "Fatal"
    case "none":
      return "None"
    default:
      return "Info"
  }
}

// ─── Structured key=value Logger ─────────────────────────────────────────────
// Outputs to stderr — stdout is reserved for Codex subprocess protocol (§13.2)

const structuredLogger = Logger.make<unknown, void>((options) => {
  const level = options.logLevel.toUpperCase()
  const ts = options.date.toISOString()

  const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
  const annotationParts: string[] = []
  for (const [key, value] of Object.entries(annotations)) {
    const v = typeof value === "object" ? JSON.stringify(value) : String(value)
    annotationParts.push(`${key}=${v}`)
  }

  const msg = Array.isArray(options.message)
    ? options.message.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" ")
    : typeof options.message === "string"
      ? options.message
      : JSON.stringify(options.message)

  let line = `level=${level} at=${ts}`
  if (annotationParts.length > 0) {
    line += " " + annotationParts.join(" ")
  }
  line += ` msg=${JSON.stringify(msg)}`

  const causeStr = Cause.pretty(options.cause)
  if (causeStr.length > 0) {
    line += ` cause=${JSON.stringify(causeStr)}`
  }

  process.stderr.write(line + "\n")
})

// ─── LoggerLive Layer ─────────────────────────────────────────────────────────

export const LoggerLive: Layer.Layer<never> = Layer.mergeAll(
  Logger.layer([structuredLogger]),
  Layer.succeed(References.MinimumLogLevel, resolveLogLevel())
)

// ─── Context annotation helpers ───────────────────────────────────────────────

export const withIssueContext =
  (issue_id: string, issue_identifier: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateLogs({ issue_id, issue_identifier })(effect)

export const withSessionContext =
  (session_id: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateLogs({ session_id })(effect)
