import { Effect, Layer } from "effect"
import { Liquid } from "liquidjs"
import type { Issue, PromptError } from "../types.js"
import { PromptEngine } from "../services.js"

const FALLBACK_PROMPT = "You are working on an issue from Linear."

// Create Liquid instance with strict mode
const liquid = new Liquid({
  strictVariables: true,
  strictFilters: true,
})

function makePromptError(
  code: PromptError["code"],
  message: string,
  cause?: unknown
): PromptError {
  return { _tag: "PromptError", code, message, cause }
}

const render = (
  template: string,
  issue: Issue,
  attempt: number | null
): Effect.Effect<string, PromptError> => {
  // If template is empty/blank, return fallback
  if (template.trim() === "") {
    return Effect.succeed(FALLBACK_PROMPT)
  }

  return Effect.tryPromise({
    try: async () => {
      // Convert issue to plain object for template compatibility
      const context = {
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description,
          priority: issue.priority,
          state: issue.state,
          branch_name: issue.branch_name,
          url: issue.url,
          labels: [...issue.labels],
          blocked_by: issue.blocked_by.map((b) => ({
            id: b.id,
            identifier: b.identifier,
            state: b.state,
          })),
          created_at: issue.created_at?.toISOString() ?? null,
          updated_at: issue.updated_at?.toISOString() ?? null,
        },
        attempt,
      }
      return await liquid.parseAndRender(template, context)
    },
    catch: (error) => {
      const msg = error instanceof Error ? error.message : String(error)
      // Distinguish parse errors from render errors
      if (
        msg.includes("parse") ||
        msg.includes("syntax") ||
        msg.includes("unexpected")
      ) {
        return makePromptError(
          "template_parse_error",
          `Template parse error: ${msg}`,
          error
        )
      }
      return makePromptError(
        "template_render_error",
        `Template render error: ${msg}`,
        error
      )
    },
  })
}

// PromptEngineLive Layer — provides PromptEngine service
export const PromptEngineLive: Layer.Layer<PromptEngine> = Layer.succeed(
  PromptEngine,
  { render }
)
