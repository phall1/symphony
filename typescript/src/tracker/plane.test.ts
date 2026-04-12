import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  fetchCandidateIssues,
  fetchIssueStatesByIds,
  fetchIssuesByStates,
  fetchProjectIdentifier,
  fetchViewerId,
} from "./plane.js"

const ENDPOINT = "https://api.plane.so"
const API_KEY = "plane-test-key"
const WORKSPACE_SLUG = "my-workspace"
const PROJECT_ID = "project-uuid"
const PROJECT_IDENTIFIER = "PROJ"
const ACTIVE_STATES = ["Todo", "In Progress"]

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makePlaneState(overrides: Record<string, unknown> = {}) {
  return {
    id: "state-in-progress",
    name: "In Progress",
    group: "started",
    ...overrides,
  }
}

function makePlaneIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    name: "Fix bug",
    description_html: "<p>Plane issue description</p>",
    priority: "high",
    sequence_id: 123,
    state: "state-in-progress",
    assignees: [{ id: "user-1" }],
    labels: [{ name: "Bug" }, { name: "Frontend" }],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    ...overrides,
  }
}

describe("Plane tracker", () => {
  it("fetchProjectIdentifier returns project identifier", async () => {
    globalThis.fetch = (((_url: unknown, options?: RequestInit) => {
      expect(options?.headers).toMatchObject({ "X-Api-Key": API_KEY })
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ identifier: PROJECT_IDENTIFIER }),
      } as Response)
    }) as unknown as typeof globalThis.fetch)

    const result = await Effect.runPromise(
      fetchProjectIdentifier(ENDPOINT, API_KEY, WORKSPACE_SLUG, PROJECT_ID)
    )

    expect(result).toBe(PROJECT_IDENTIFIER)
  })

  it("fetchViewerId returns current user id", async () => {
    globalThis.fetch = ((() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: "viewer-1" }),
      } as Response)) as unknown as typeof globalThis.fetch)

    const result = await Effect.runPromise(fetchViewerId(ENDPOINT, API_KEY))
    expect(result).toBe("viewer-1")
  })

  it("fetchCandidateIssues paginates, resolves state ids, normalizes labels, priorities, and blocked_by", async () => {
    const requests: string[] = []

    globalThis.fetch = (((url: string | URL) => {
      requests.push(String(url))

      if (String(url).includes(`/projects/${PROJECT_ID}/states/`)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            next_page_results: false,
            next_cursor: null,
            results: [
              makePlaneState({ id: "state-todo", name: "Todo", group: "unstarted" }),
              makePlaneState({ id: "state-done", name: "Done", group: "completed" }),
            ],
          }),
        } as Response)
      }

      if (String(url).includes(`/projects/${PROJECT_ID}/work-items/?`) && !String(url).includes("cursor=cursor-2")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            next_page_results: true,
            next_cursor: "cursor-2",
            results: [
              makePlaneIssue({ id: "issue-1", sequence_id: 123, state: "state-todo" }),
            ],
          }),
        } as Response)
      }

      if (String(url).includes("cursor=cursor-2")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            next_page_results: false,
            next_cursor: null,
            results: [
              makePlaneIssue({
                id: "issue-2",
                sequence_id: 124,
                state: "state-done",
                labels: [{ name: "Backend" }],
              }),
            ],
          }),
        } as Response)
      }

      if (String(url).includes("/work-items/issue-1/relations/")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ blocked_by: ["issue-2"] }),
        } as Response)
      }

      throw new Error(`Unexpected URL: ${String(url)}`)
    }) as unknown as typeof globalThis.fetch)

    const result = await Effect.runPromise(
      fetchCandidateIssues(
        ENDPOINT,
        API_KEY,
        WORKSPACE_SLUG,
        PROJECT_ID,
        PROJECT_IDENTIFIER,
        ACTIVE_STATES,
      )
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.identifier).toBe("PROJ-123")
    expect(result[0]?.state).toBe("Todo")
    expect(result[0]?.description).toContain("Plane issue description")
    expect(result[0]?.labels).toEqual(["bug", "frontend"])
    expect(result[0]?.priority).toBe(2)
    expect(result[0]?.blocked_by).toEqual([
      { id: "issue-2", identifier: "PROJ-124", state: "Done" },
    ])
    expect(requests.some((url) => url.includes(`/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/states/`))).toBe(true)
    expect(requests.some((url) => url.includes(`/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/work-items/`))).toBe(true)
  })

  it("fetchIssueStatesByIds fetches each issue detail and resolves state ids using project states", async () => {
    globalThis.fetch = (((url: string | URL) => {
      if (String(url).includes(`/projects/${PROJECT_ID}/states/`)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            next_page_results: false,
            next_cursor: null,
            results: [
              makePlaneState({ id: "state-done", name: "Done" }),
              makePlaneState({ id: "state-canceled", name: "Canceled", group: "cancelled" }),
            ],
          }),
        } as Response)
      }
      if (String(url).includes("/work-items/issue-1/")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makePlaneIssue({ id: "issue-1", state: "state-done", sequence_id: 201 })),
        } as Response)
      }
      if (String(url).includes("/work-items/issue-2/")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makePlaneIssue({ id: "issue-2", state: "state-canceled", sequence_id: 202 })),
        } as Response)
      }
      throw new Error(`Unexpected URL: ${String(url)}`)
    }) as unknown as typeof globalThis.fetch)

    const result = await Effect.runPromise(
      fetchIssueStatesByIds(
        ENDPOINT,
        API_KEY,
        WORKSPACE_SLUG,
        PROJECT_ID,
        PROJECT_IDENTIFIER,
        ["issue-1", "issue-2"],
      )
    )

    expect(result.map((issue) => issue.identifier)).toEqual(["PROJ-201", "PROJ-202"])
    expect(result.map((issue) => issue.state)).toEqual(["Done", "Canceled"])
  })

  it("fetchIssuesByStates filters terminal issues using state ids", async () => {
    globalThis.fetch = (((url: string | URL) => {
      if (String(url).includes(`/projects/${PROJECT_ID}/states/`)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            next_page_results: false,
            next_cursor: null,
            results: [
              makePlaneState({ id: "state-done", name: "Done" }),
              makePlaneState({ id: "state-canceled", name: "Canceled" }),
              makePlaneState({ id: "state-progress", name: "In Progress" }),
            ],
          }),
        } as Response)
      }
      if (String(url).includes(`/projects/${PROJECT_ID}/work-items/`)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            next_page_results: false,
            next_cursor: null,
            results: [
              makePlaneIssue({ id: "issue-1", sequence_id: 1, state: "state-done" }),
              makePlaneIssue({ id: "issue-2", sequence_id: 2, state: "state-canceled" }),
              makePlaneIssue({ id: "issue-3", sequence_id: 3, state: "state-progress" }),
            ],
          }),
        } as Response)
      }
      throw new Error(`Unexpected URL: ${String(url)}`)
    }) as unknown as typeof globalThis.fetch)

    const result = await Effect.runPromise(
      fetchIssuesByStates(
        ENDPOINT,
        API_KEY,
        WORKSPACE_SLUG,
        PROJECT_ID,
        PROJECT_IDENTIFIER,
        ["Done", "Canceled"],
      )
    )

    expect(result.map((issue) => issue.identifier)).toEqual(["PROJ-1", "PROJ-2"])
  })

  it("fails with plane_missing_next_cursor when Plane pagination is inconsistent", async () => {
    globalThis.fetch = (((url: string | URL) => {
      if (String(url).includes(`/projects/${PROJECT_ID}/states/`)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            next_page_results: false,
            next_cursor: null,
            results: [makePlaneState({ id: "state-todo", name: "Todo" })],
          }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          next_page_results: true,
          next_cursor: null,
          results: [makePlaneIssue({ state: "state-todo" })],
        }),
      } as Response)
    }) as unknown as typeof globalThis.fetch)

    const error = await Effect.runPromise(
      Effect.flip(
        fetchCandidateIssues(
          ENDPOINT,
          API_KEY,
          WORKSPACE_SLUG,
          PROJECT_ID,
          PROJECT_IDENTIFIER,
          ACTIVE_STATES,
        )
      )
    )

    expect(error._tag).toBe("TrackerError")
    expect(error.code).toBe("plane_missing_next_cursor")
  })
})
