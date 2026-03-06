import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "./args.js"

const TS_DIR = resolve(process.cwd())
const CLI_ENTRY = resolve(TS_DIR, "src/cli/index.ts")
const BUN_ENV = { ...process.env, PATH: `/Users/phall/.bun/bin:${process.env.PATH ?? ""}` }

function spawnCLI(args: string[], cwd?: string) {
  return spawnSync("bun", ["run", CLI_ENTRY, ...args], {
    cwd: cwd ?? TS_DIR,
    env: BUN_ENV,
    encoding: "utf8",
    timeout: 10_000,
  })
}

describe("§17.7 CLI and Host Lifecycle", () => {
  describe("CLI accepts optional positional workflow path", () => {
    it("parseArgs returns the explicit path when provided", () => {
      const result = parseArgs(["bun", "symphony", "./custom-workflow.md"])
      expect(result).not.toBeNull()
      expect(result).not.toBe("error")
      expect((result as { workflowPath: string }).workflowPath).toBe("./custom-workflow.md")
    })

    it("parseArgs returns explicit path even when it looks like a relative path", () => {
      const result = parseArgs(["bun", "symphony", "path/to/my-workflow.md"])
      expect(result).not.toBeNull()
      expect(result).not.toBe("error")
      expect((result as { workflowPath: string }).workflowPath).toBe("path/to/my-workflow.md")
    })
  })

  describe("CLI uses ./WORKFLOW.md when no path provided", () => {
    it("parseArgs defaults to ./WORKFLOW.md when no positional arg given", () => {
      const result = parseArgs(["bun", "symphony"])
      expect(result).not.toBeNull()
      expect(result).not.toBe("error")
      expect((result as { workflowPath: string }).workflowPath).toBe("./WORKFLOW.md")
    })

    it("parseArgs defaults to ./WORKFLOW.md even when --port is given without a path", () => {
      const result = parseArgs(["bun", "symphony", "--port", "3000"])
      expect(result).not.toBeNull()
      expect(result).not.toBe("error")
      expect((result as { workflowPath: string; port: number | null }).workflowPath).toBe("./WORKFLOW.md")
      expect((result as { workflowPath: string; port: number | null }).port).toBe(3000)
    })
  })

  describe("CLI errors on nonexistent explicit workflow path", () => {
    it("exits 1 with error message when explicit path does not exist", () => {
      const result = spawnCLI(["./definitely-does-not-exist-xyz-12345.md"])
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/workflow file not found/)
    })

    it("error message includes the resolved path", () => {
      const result = spawnCLI(["./missing-workflow-test.md"])
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/missing-workflow-test\.md/)
    })
  })

  describe("CLI errors on missing default ./WORKFLOW.md", () => {
    it("exits 1 when run from a directory with no WORKFLOW.md and no path given", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "symphony-cli-test-"))
      try {
        const result = spawnCLI([], tmpDir)
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/workflow file not found/)
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    })
  })

  describe("CLI surfaces startup failure cleanly", () => {
    it("error output is human-readable — not a raw stack trace", () => {
      const result = spawnCLI(["./nonexistent-workflow.md"])
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/^Error:/m)
      expect(result.stderr).not.toMatch(/at Object\.<anonymous>/)
      expect(result.stderr).not.toMatch(/TypeError:/)
    })

    it("parseArgs returns error sentinel for unknown flags", () => {
      const result = parseArgs(["bun", "symphony", "--unknown-flag"])
      expect(result).toBe("error")
    })

    it("parseArgs returns null for --help flag", () => {
      const result = parseArgs(["bun", "symphony", "--help"])
      expect(result).toBeNull()
    })
  })
})
