import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { BunRuntime } from "@effect/platform-bun"
import { main } from "../main.js"
import { parseArgs, printUsage } from "./args.js"

const parsed = parseArgs(process.argv)

if (parsed === null) {
  printUsage()
  process.exit(0)
}

if (parsed === "error") {
  printUsage()
  process.exit(1)
}

const { workflowPath, port, debug } = parsed

if (debug) {
  process.env["LOG_LEVEL"] = "debug"
}

const resolvedPath = resolve(workflowPath)
if (!existsSync(resolvedPath)) {
  process.stderr.write(`Error: workflow file not found: ${resolvedPath}\n`)
  process.exit(1)
}

// BunRuntime.runMain keeps the process alive, handles SIGTERM/SIGINT gracefully,
// and exits with the correct exit code when the Effect completes or fails.
BunRuntime.runMain(main(resolvedPath, port ?? 0))
