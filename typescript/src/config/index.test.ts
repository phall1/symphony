import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { homedir } from "node:os"
import { parseWorkflowContent, loadWorkflowFile, resolveConfig, validateDispatchConfig } from "./index.js"
import type { WorkflowError } from "../types.js"

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
})

describe("loadWorkflowFile", () => {
  it("fails with missing_workflow_file for nonexistent path", async () => {
    const error = await Effect.runPromise(
      Effect.flip(loadWorkflowFile("/nonexistent/path/symphony-test-file-xyz.md"))
    )
    expect((error as WorkflowError).code).toBe("missing_workflow_file")
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
})
