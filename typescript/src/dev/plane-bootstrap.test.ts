import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readBootstrapState, writeBootstrapState } from "./plane-bootstrap.js"
import type { BootstrapResult } from "./plane-bootstrap.js"

describe("plane-bootstrap state persistence", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "plane-bootstrap-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("readBootstrapState returns null when no file exists", async () => {
    const result = await readBootstrapState(tempDir)
    expect(result).toBeNull()
  })

  it("writeBootstrapState writes and readBootstrapState reads back correctly", async () => {
    const state: BootstrapResult = {
      apiKey: "test-api-key-123",
      workspaceSlug: "symphony",
      projectId: "project-uuid-456",
      adminEmail: "admin@symphony.local",
    }

    await writeBootstrapState(tempDir, state)
    const result = await readBootstrapState(tempDir)

    expect(result).toEqual(state)
  })

  it("readBootstrapState returns null for corrupted (non-JSON) file", async () => {
    await writeFile(join(tempDir, "bootstrap.json"), "this is not json {{{", "utf8")

    const result = await readBootstrapState(tempDir)
    expect(result).toBeNull()
  })

  it("readBootstrapState returns null for JSON missing required fields", async () => {
    await writeFile(
      join(tempDir, "bootstrap.json"),
      JSON.stringify({ apiKey: "key-only", somethingElse: true }),
      "utf8",
    )

    const result = await readBootstrapState(tempDir)
    expect(result).toBeNull()
  })
})
