import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { PromptEngineLive } from "./index.js"
import { PromptEngine } from "../services.js"
import type { Issue } from "../types.js"

const testIssue: Issue = {
  id: "issue-123",
  identifier: "MT-123",
  title: "Fix auth bug",
  description: "The auth is broken",
  priority: 1,
  state: "In Progress",
  branch_name: "fix/auth",
  url: "https://linear.app/mt-123",
  labels: ["bug", "auth"],
  blocked_by: [],
  created_at: new Date("2024-01-01"),
  updated_at: new Date("2024-01-02"),
}

const runWithPromptEngine = <A, E>(
  effect: Effect.Effect<A, E, PromptEngine>
) => Effect.runPromise(Effect.provide(effect, PromptEngineLive))

describe("PromptEngine", () => {
  it("renders issue.identifier correctly", async () => {
    const result = await runWithPromptEngine(
      Effect.gen(function* () {
        const svc = yield* PromptEngine
        return yield* svc.render("Issue: {{ issue.identifier }}", testIssue, null)
      })
    )
    expect(result).toBe("Issue: MT-123")
  })

  it("renders attempt as null on first run", async () => {
    const result = await runWithPromptEngine(
      Effect.gen(function* () {
        const svc = yield* PromptEngine
        return yield* svc.render("Attempt: {{ attempt }}", testIssue, null)
      })
    )
    expect(result).toBe("Attempt: ")
  })

  it("renders attempt as number on retry", async () => {
    const result = await runWithPromptEngine(
      Effect.gen(function* () {
        const svc = yield* PromptEngine
        return yield* svc.render("Attempt: {{ attempt }}", testIssue, 2)
      })
    )
    expect(result).toBe("Attempt: 2")
  })

  it("returns fallback prompt for empty template", async () => {
    const result = await runWithPromptEngine(
      Effect.gen(function* () {
        const svc = yield* PromptEngine
        return yield* svc.render("", testIssue, null)
      })
    )
    expect(result).toBe("You are working on an issue from Linear.")
  })

  it("returns fallback prompt for whitespace-only template", async () => {
    const result = await runWithPromptEngine(
      Effect.gen(function* () {
        const svc = yield* PromptEngine
        return yield* svc.render("   \n  ", testIssue, null)
      })
    )
    expect(result).toBe("You are working on an issue from Linear.")
  })

  it("fails with PromptError for unknown variable in strict mode", async () => {
    const effect = Effect.gen(function* () {
      const svc = yield* PromptEngine
      return yield* svc.render("{{ issue.nonexistent_field }}", testIssue, null)
    })
    await expect(
      Effect.runPromise(Effect.provide(effect, PromptEngineLive))
    ).rejects.toThrow()
  })

  it("renders labels array with for loop", async () => {
    const template = "{% for label in issue.labels %}{{ label }} {% endfor %}"
    const result = await runWithPromptEngine(
      Effect.gen(function* () {
        const svc = yield* PromptEngine
        return yield* svc.render(template, testIssue, null)
      })
    )
    expect(result).toContain("bug")
    expect(result).toContain("auth")
  })

  it("renders multiple issue fields in complex template", async () => {
    const template =
      "{{ issue.identifier }}: {{ issue.title }} ({{ issue.state }})"
    const result = await runWithPromptEngine(
      Effect.gen(function* () {
        const svc = yield* PromptEngine
        return yield* svc.render(template, testIssue, null)
      })
    )
    expect(result).toBe("MT-123: Fix auth bug (In Progress)")
  })
})
