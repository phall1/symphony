import { Effect, Fiber } from "effect"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { main } from "../main.js"

function printUsage(): void {
  process.stdout.write(`Usage: symphony [workflow-path] [--port <n>]

Options:
  workflow-path  Path to WORKFLOW.md (default: ./WORKFLOW.md)
  --port <n>     Enable HTTP observability server on port n
  --help         Print this message and exit

Examples:
  symphony
  symphony ./my-workflow.md
  symphony ./my-workflow.md --port 3000
`)
}

interface ParsedArgs {
  workflowPath: string
  port: number | null
}

type ParseResult = ParsedArgs | null | "error"

function parseArgs(argv: string[]): ParseResult {
  const args = argv.slice(2)

  let workflowPath = "./WORKFLOW.md"
  let port: number | null = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!

    if (arg === "--help") {
      return null
    }

    if (arg === "--port") {
      const nextArg = args[i + 1]
      if (!nextArg) {
        process.stderr.write("Error: --port requires a number argument\n")
        return "error"
      }
      const portNum = parseInt(nextArg, 10)
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        process.stderr.write(`Error: --port must be a valid port number (1-65535), got: ${nextArg}\n`)
        return "error"
      }
      port = portNum
      i++
      continue
    }

    if (!arg.startsWith("--")) {
      workflowPath = arg
      continue
    }

    process.stderr.write(`Error: unknown option: ${arg}\n`)
    return "error"
  }

  return { workflowPath, port }
}

async function runCLI(): Promise<void> {
  const parsed = parseArgs(process.argv)

  if (parsed === null) {
    printUsage()
    process.exit(0)
  }

  if (parsed === "error") {
    printUsage()
    process.exit(1)
  }

  const { workflowPath } = parsed

  const resolvedPath = resolve(workflowPath)
  if (!existsSync(resolvedPath)) {
    process.stderr.write(`Error: workflow file not found: ${resolvedPath}\n`)
    process.exit(1)
  }

  const fiber = Effect.runFork(main(resolvedPath))

  const handleSignal = (signal: string) => {
    process.stderr.write(`\n[CLI] Received ${signal}, shutting down...\n`)
    Effect.runPromise(Fiber.interrupt(fiber)).then(
      () => {
        process.exit(0)
      },
      (err) => {
        process.stderr.write(`[CLI] Error during shutdown: ${String(err)}\n`)
        process.exit(1)
      }
    )
  }

  process.on("SIGTERM", () => handleSignal("SIGTERM"))
  process.on("SIGINT", () => handleSignal("SIGINT"))
}

runCLI().catch((err) => {
  process.stderr.write(`[CLI] Fatal error: ${String(err)}\n`)
  process.exit(1)
})
