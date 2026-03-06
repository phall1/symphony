import { Effect, Fiber } from "effect"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { main } from "../main.js"
import { parseArgs, printUsage } from "./args.js"

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
