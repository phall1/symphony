import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { parse as parseYaml } from "yaml"
import type { WorkflowDefinition, WorkflowConfig, WorkflowError } from "../types.js"

export function parseWorkflowContent(content: string): WorkflowDefinition {
  if (!content.startsWith("---")) {
    return { config: {}, prompt_template: content.trim() }
  }
  const endIndex = content.indexOf("\n---", 3)
  if (endIndex === -1) {
    return { config: {}, prompt_template: content.trim() }
  }
  const frontMatterStr = content.slice(3, endIndex).trim()
  const promptBody = content.slice(endIndex + 4).trim()

  let parsed: unknown
  try {
    parsed = parseYaml(frontMatterStr)
  } catch (error) {
    const e: WorkflowError = {
      _tag: "WorkflowError",
      code: "workflow_parse_error",
      message: `YAML parse error: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    }
    throw e
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const e: WorkflowError = {
      _tag: "WorkflowError",
      code: "workflow_front_matter_not_a_map",
      message: "YAML front matter must be a plain object/map",
    }
    throw e
  }

  return { config: parsed as WorkflowConfig, prompt_template: promptBody }
}

export function loadWorkflowFile(filePath: string): Effect.Effect<WorkflowDefinition, WorkflowError> {
  return Effect.tryPromise({
    try: async () => {
      const content = await readFile(filePath, "utf-8")
      return parseWorkflowContent(content)
    },
    catch: (error) => {
      if (error !== null && typeof error === "object" && "_tag" in error) {
        return error as WorkflowError
      }
      const isNotFound =
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      if (isNotFound) {
        return {
          _tag: "WorkflowError" as const,
          code: "missing_workflow_file" as const,
          message: `Workflow file not found: ${filePath}`,
          cause: error,
        }
      }
      return {
        _tag: "WorkflowError" as const,
        code: "workflow_parse_error" as const,
        message: `Failed to read workflow file: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      }
    },
  })
}
