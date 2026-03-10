import { describe, it, expect, afterEach } from "vitest"
import { Effect, Ref } from "effect"
import { homedir, tmpdir } from "node:os"
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseWorkflowContent, loadWorkflowFile, resolveConfig, validateDispatchConfig } from "./index.js"
import { watchWorkflowFile } from "./watcher.js"
import type { WorkflowDefinition, ResolvedConfig, WorkflowError } from "../types.js"

let tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "symphony-cfg-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe("parseWorkflowContent", () => {
  it("parses valid YAML front matter into config and prompt", () => {
    const content = "---\ntracker:\n  kind: linear\n  project_slug: my-proj\n---\nImplement the feature"
    const result = parseWorkflowContent(content)
    expect(result.config).toMatchObject({ tracker: { kind: "linear", project_slug: "my-proj" } })
    expect(result.prompt_template).toBe("Implement the feature")
  })

  it("returns empty config and full content as template when no front matter", () => {
    const content = "Just a plain prompt with no front matter"
    const result = parseWorkflowContent(content)
    expect(result.config).toEqual({})
    expect(result.prompt_template).toBe("Just a plain prompt with no front matter")
  })

  it("throws workflow_front_matter_not_a_map when front matter is not a map", () => {
    let caught: unknown
    try {
      parseWorkflowContent("---\nhello\n---\nbody")
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ _tag: "WorkflowError", code: "workflow_front_matter_not_a_map" })
  })

  it("throws workflow_parse_error for invalid YAML syntax (§17.1)", () => {
    let caught: unknown
    try {
      parseWorkflowContent("---\nkey: [\n---\nbody")
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ _tag: "WorkflowError", code: "workflow_parse_error" })
  })
})

describe("loadWorkflowFile", () => {
  it("fails with missing_workflow_file for nonexistent path", async () => {
    const error = await Effect.runPromise(
      Effect.flip(loadWorkflowFile("/nonexistent/path/symphony-test-file-xyz.md"))
    )
    expect((error as WorkflowError).code).toBe("missing_workflow_file")
  })

  it("succeeds loading from explicit file path and returns correct config", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "WORKFLOW.md")
    await writeFile(
      filePath,
      "---\ntracker:\n  kind: linear\n  project_slug: explicit-proj\n---\nExplicit prompt"
    )

    const result = await Effect.runPromise(loadWorkflowFile(filePath))
    expect(result.config).toMatchObject({ tracker: { project_slug: "explicit-proj" } })
    expect(result.prompt_template).toBe("Explicit prompt")
  })
})

describe("resolveConfig", () => {
  it("resolves $LINEAR_API_KEY from process.env", () => {
    const saved = process.env["LINEAR_API_KEY"]
    process.env["LINEAR_API_KEY"] = "test-key-from-env"
    try {
      const config = resolveConfig({ tracker: { api_key: "$LINEAR_API_KEY" } })
      expect(config.tracker.api_key).toBe("test-key-from-env")
    } finally {
      if (saved === undefined) {
        delete process.env["LINEAR_API_KEY"]
      } else {
        process.env["LINEAR_API_KEY"] = saved
      }
    }
  })

  it("expands ~ in workspace.root to homedir", () => {
    const config = resolveConfig({ workspace: { root: "~/projects/work" } })
    expect(config.workspace.root).toBe(`${homedir()}/projects/work`)
  })

  it("splits comma-separated active_states string into array", () => {
    const config = resolveConfig({
      tracker: { active_states: "Todo, In Progress, Review" as unknown as ReadonlyArray<string> },
    })
    expect(config.tracker.active_states).toEqual(["Todo", "In Progress", "Review"])
  })

  it("applies all defaults when optional values are missing", () => {
    const config = resolveConfig({})
    expect(config.polling.interval_ms).toBe(30000)
    expect(config.agent.max_concurrent_agents).toBe(10)
    expect(config.agent.max_turns).toBe(20)
    expect(config.agent.max_retry_backoff_ms).toBe(300000)
    expect(config.tracker.kind).toBe("")
    expect(config.tracker.active_states).toEqual(["Todo", "In Progress"])
    expect(config.tracker.terminal_states).toContain("Done")
    expect(config.hooks.timeout_ms).toBe(60000)
  })

  it("preserves codex.command as-is without env var expansion", () => {
    const saved = process.env["MY_CODEX_CMD"]
    process.env["MY_CODEX_CMD"] = "resolved-binary"
    try {
      const config = resolveConfig({ codex: { command: "$MY_CODEX_CMD" } })
      expect(config.codex.command).toBe("$MY_CODEX_CMD")
    } finally {
      if (saved === undefined) {
        delete process.env["MY_CODEX_CMD"]
      } else {
        process.env["MY_CODEX_CMD"] = saved
      }
    }
  })

  it("normalizes state names to lowercase and ignores invalid values in max_concurrent_agents_by_state", () => {
    const config = resolveConfig({
      agent: {
        max_concurrent_agents_by_state: {
          "In Progress": 5,
          "  REVIEW  ": 2,
          "bad-negative": -1,
          "bad-zero": 0,
        } as Record<string, number>,
      },
    })
    expect(config.agent.max_concurrent_agents_by_state["in progress"]).toBe(5)
    expect(config.agent.max_concurrent_agents_by_state["review"]).toBe(2)
    expect(config.agent.max_concurrent_agents_by_state["bad-negative"]).toBeUndefined()
    expect(config.agent.max_concurrent_agents_by_state["bad-zero"]).toBeUndefined()
  })

  it("resolves $VAR in tracker.api_key from env (§17.1 $VAR)", () => {
    const saved = process.env["TRACKER_KEY_TEST"]
    process.env["TRACKER_KEY_TEST"] = "resolved-key-abc"
    try {
      const config = resolveConfig({ tracker: { api_key: "$TRACKER_KEY_TEST" } })
      expect(config.tracker.api_key).toBe("resolved-key-abc")
    } finally {
      if (saved === undefined) {
        delete process.env["TRACKER_KEY_TEST"]
      } else {
        process.env["TRACKER_KEY_TEST"] = saved
      }
    }
  })

  it("expands $VAR then ~ in workspace.root path value (§17.1 ~ expansion)", () => {
    const saved = process.env["MY_WORKSPACE_ROOT"]
    process.env["MY_WORKSPACE_ROOT"] = "~/my-workspaces"
    try {
      const config = resolveConfig({ workspace: { root: "$MY_WORKSPACE_ROOT" } })
      expect(config.workspace.root).toBe(`${homedir()}/my-workspaces`)
    } finally {
      if (saved === undefined) {
        delete process.env["MY_WORKSPACE_ROOT"]
      } else {
        process.env["MY_WORKSPACE_ROOT"] = saved
      }
    }
  })
})

describe("validateDispatchConfig", () => {
  it("returns missing_tracker_project_slug error when project_slug is absent", () => {
    const config = resolveConfig({ tracker: { kind: "linear", api_key: "my-key" } })
    const errors = validateDispatchConfig(config)
    const slugError = errors.find((e) => e.code === "missing_tracker_project_slug")
    expect(slugError).toBeDefined()
  })

  it("returns empty array when all required fields are present", () => {
    const config = resolveConfig({
      tracker: { kind: "linear", api_key: "my-key", project_slug: "my-project" },
    })
    const errors = validateDispatchConfig(config)
    expect(errors).toHaveLength(0)
  })

  it("returns unsupported_tracker_kind error for non-linear tracker kind (§17.1 tracker.kind)", () => {
    const config = resolveConfig({
      tracker: {
        kind: "github" as unknown as "linear",
        api_key: "my-key",
        project_slug: "proj",
      },
    })
    const errors = validateDispatchConfig(config)
    const kindError = errors.find((e) => e.code === "unsupported_tracker_kind")
    expect(kindError).toBeDefined()
  })

  it("fails fast when engine is opencode and opencode.agent is missing", () => {
    const config = resolveConfig({
      tracker: { kind: "linear", api_key: "my-key", project_slug: "my-project" },
      agent: { engine: "opencode" },
      opencode: { agent: "" },
    })
    const errors = validateDispatchConfig(config)
    expect(
      errors.some((e) => e.message.includes("opencode.agent is required when agent.engine is \"opencode\"")),
    ).toBe(true)
  })

  it("accepts opencode engine when opencode.agent is set", () => {
    const config = resolveConfig({
      tracker: { kind: "linear", api_key: "my-key", project_slug: "my-project" },
      agent: { engine: "opencode" },
      opencode: { agent: "build" },
    })
    const errors = validateDispatchConfig(config)
    expect(errors).toHaveLength(0)
  })
})

describe("watchWorkflowFile", () => {
  it("file change triggers re-read and re-applies new config (§17.1 watcher)", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "WORKFLOW.md")
    await writeFile(
      filePath,
      "---\ntracker:\n  kind: linear\n  project_slug: original-slug\n---\nOriginal prompt"
    )
    const def = parseWorkflowContent(await readFile(filePath, "utf-8"))
    const workflowRef = await Effect.runPromise(Ref.make<WorkflowDefinition>(def))
    const resolvedRef = await Effect.runPromise(
      Ref.make<ResolvedConfig>(resolveConfig(def.config))
    )
    const stop = await Effect.runPromise(
      watchWorkflowFile(filePath, workflowRef, resolvedRef, () => {})
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      await writeFile(
        filePath,
        "---\ntracker:\n  kind: linear\n  project_slug: updated-slug\n---\nUpdated prompt"
      )
      const deadline = Date.now() + 4000
      let resolved = await Effect.runPromise(Ref.get(resolvedRef))
      while (resolved.tracker.project_slug !== "updated-slug" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        resolved = await Effect.runPromise(Ref.get(resolvedRef))
      }
      expect(resolved.tracker.project_slug).toBe("updated-slug")
      const workflow = await Effect.runPromise(Ref.get(workflowRef))
      expect(workflow.prompt_template).toBe("Updated prompt")
    } finally {
      stop()
    }
  }, 8000)

  it("invalid reload keeps last-known-good config (§17.1 last-known-good)", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "WORKFLOW.md")
    await writeFile(
      filePath,
      "---\ntracker:\n  kind: linear\n  project_slug: good-config\n---\nGood prompt"
    )
    const def = parseWorkflowContent(await readFile(filePath, "utf-8"))
    const workflowRef = await Effect.runPromise(Ref.make<WorkflowDefinition>(def))
    const resolvedRef = await Effect.runPromise(
      Ref.make<ResolvedConfig>(resolveConfig(def.config))
    )
    const errors: unknown[] = []
    const stop = await Effect.runPromise(
      watchWorkflowFile(filePath, workflowRef, resolvedRef, (e) => errors.push(e))
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      await writeFile(filePath, "---\nkey: [\n---\nbody")
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const resolved = await Effect.runPromise(Ref.get(resolvedRef))
      expect(resolved.tracker.project_slug).toBe("good-config")
    } finally {
      stop()
    }
  }, 8000)
})
