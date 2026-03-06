// ─── CLI Argument Parsing ────────────────────────────────────────────────────

export interface ParsedArgs {
  workflowPath: string
  port: number | null
}

export type ParseResult = ParsedArgs | null | "error"

export function printUsage(): void {
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

export function parseArgs(argv: string[]): ParseResult {
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
        process.stderr.write(
          `Error: --port must be a valid port number (1-65535), got: ${nextArg}\n`
        )
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
