import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { WorkflowStore, TrackerClient } from "../services.js"
import { resolveConfig } from "../config/index.js"
import { TrackerClientLive } from "./index.js"

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makeWorkflowStoreLayer(config: ReturnType<typeof resolveConfig>) {
  return Layer.succeed(WorkflowStore, {
    get: () => Effect.die("not used in tracker tests"),
    getResolved: () => Effect.succeed(config),
  })
}

describe("TrackerClientLive", () => {
  it("selects Linear tracker when tracker.kind is linear", async () => {
    let capturedBody = ""
    globalThis.fetch = (((_url: string | URL, options?: RequestInit) => {
      capturedBody = String(options?.body ?? "")
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          data: {
            issues: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      } as Response)
    }) as unknown as typeof globalThis.fetch)

    const config = resolveConfig({
      tracker: {
        kind: "linear",
        api_key: "lin-key",
        project_slug: "linear-project",
      },
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const tracker = yield* TrackerClient
        return yield* tracker.fetchCandidateIssues()
      }).pipe(
        Effect.provide(TrackerClientLive.pipe(Layer.provide(makeWorkflowStoreLayer(config))))
      )
    )

    expect(result).toEqual([])
    expect(capturedBody).toContain("CandidateIssues")
    expect(capturedBody).toContain("linear-project")
  })

  it("selects Plane tracker when tracker.kind is plane", async () => {
    const requestedUrls: string[] = []
    globalThis.fetch = (((url: string | URL) => {
      requestedUrls.push(String(url))

      if (String(url).includes(`/projects/project-uuid/states/`)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            next_page_results: false,
            next_cursor: null,
            results: [],
          }),
        } as Response)
      }

      if (String(url).includes(`/projects/project-uuid/`) && !String(url).includes("work-items") && !String(url).includes("states")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ identifier: "PROJ" }),
        } as Response)
      }

      if (String(url).includes("/work-items/")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            next_page_results: false,
            next_cursor: null,
            results: [],
          }),
        } as Response)
      }

      throw new Error(`Unexpected URL: ${String(url)}`)
    }) as unknown as typeof globalThis.fetch)

    const config = resolveConfig({
      tracker: {
        kind: "plane",
        api_key: "plane-key",
        workspace_slug: "plane-workspace",
        project_id: "project-uuid",
      },
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const tracker = yield* TrackerClient
        return yield* tracker.fetchCandidateIssues()
      }).pipe(
        Effect.provide(TrackerClientLive.pipe(Layer.provide(makeWorkflowStoreLayer(config))))
      )
    )

    expect(result).toEqual([])
    expect(requestedUrls[0]).toContain("/api/v1/workspaces/plane-workspace/projects/project-uuid/")
    expect(requestedUrls.some((url) => url.includes("/api/v1/workspaces/plane-workspace/projects/project-uuid/work-items/"))).toBe(true)
    expect(requestedUrls.some((url) => url.includes("/api/v1/workspaces/plane-workspace/projects/project-uuid/states/"))).toBe(true)
  })
})
