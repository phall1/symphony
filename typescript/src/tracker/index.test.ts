import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { Effect } from "effect"
import { fetchCandidateIssues, fetchIssueStatesByIds, fetchIssuesByStates } from "./index.js"

const ENDPOINT = "https://api.linear.app/graphql"
const API_KEY = "test-api-key"
const PROJECT_SLUG = "test-project"
const ACTIVE_STATES = ["In Progress", "Todo"]

// Store original fetch and restore after each test
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetch(response: unknown) {
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(response),
    } as Response)) as unknown as typeof globalThis.fetch
}

function mockFetchError(status: number, statusText: string) {
  globalThis.fetch = ((() =>
    Promise.resolve({
      ok: false,
      status,
      statusText,
      json: () => Promise.resolve({}),
    } as Response)) as unknown as typeof globalThis.fetch)
}

function makeIssueNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "id-1",
    identifier: "SYM-1",
    title: "Fix bug",
    description: "A bug",
    priority: 1,
    state: { name: "In Progress" },
    branchName: "fix/bug",
    url: "https://linear.app/sym-1",
    labels: { nodes: [{ name: "Bug" }, { name: "Frontend" }] },
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
    inverseRelations: { nodes: [] },
    ...overrides,
  }
}

function singlePageResponse(nodes: unknown[]) {
  return {
    data: {
      issues: {
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  }
}

function captureAndMockFetch(response: unknown): { lastBody: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {}
  globalThis.fetch = (((_url: unknown, options: unknown) => {
    if (options && typeof options === "object" && "body" in options) {
      captured = JSON.parse(options.body as string) as Record<string, unknown>
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(response),
    } as Response)
  }) as unknown as typeof globalThis.fetch)
  return { lastBody: () => captured }
}

describe("fetchCandidateIssues", () => {
  it("single page response returns normalized issues with labels lowercased", async () => {
    mockFetch(singlePageResponse([makeIssueNode()]))

    const result = await Effect.runPromise(
      fetchCandidateIssues(ENDPOINT, API_KEY, PROJECT_SLUG, ACTIVE_STATES)
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.identifier).toBe("SYM-1")
    expect(result[0]?.labels).toEqual(["bug", "frontend"])
    expect(result[0]?.state).toBe("In Progress")
  })

  it("two-page response returns all issues in order", async () => {
    let callCount = 0
    globalThis.fetch = ((() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: {
                issues: {
                  nodes: [makeIssueNode({ id: "id-1", identifier: "SYM-1" })],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-abc" },
                },
              },
            }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {
              issues: {
                nodes: [makeIssueNode({ id: "id-2", identifier: "SYM-2" })],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
      } as Response)
    }) as unknown as typeof globalThis.fetch)

    const result = await Effect.runPromise(
      fetchCandidateIssues(ENDPOINT, API_KEY, PROJECT_SLUG, ACTIVE_STATES)
    )

    expect(result).toHaveLength(2)
    expect(result[0]?.identifier).toBe("SYM-1")
    expect(result[1]?.identifier).toBe("SYM-2")
    expect(callCount).toBe(2)
  })

  it("normalizes blockers from relations.nodes[].relatedIssue", async () => {
    const nodeWithBlocker = makeIssueNode({
      inverseRelations: {
        nodes: [
          {
            relatedIssue: {
              id: "blocker-id",
              identifier: "SYM-0",
              state: { name: "In Progress" },
            },
          },
        ],
      },
    })
    mockFetch(singlePageResponse([nodeWithBlocker]))

    const result = await Effect.runPromise(
      fetchCandidateIssues(ENDPOINT, API_KEY, PROJECT_SLUG, ACTIVE_STATES)
    )

    expect(result[0]?.blocked_by).toHaveLength(1)
    expect(result[0]?.blocked_by[0]?.identifier).toBe("SYM-0")
    expect(result[0]?.blocked_by[0]?.state).toBe("In Progress")
  })

  it("sends active states and project slug as query variables (§17.3 candidate fetch uses active states + slug)", async () => {
    const { lastBody } = captureAndMockFetch(singlePageResponse([]))
    await Effect.runPromise(fetchCandidateIssues(ENDPOINT, API_KEY, PROJECT_SLUG, ACTIVE_STATES))
    const vars = lastBody().variables as Record<string, unknown>
    expect(vars["projectSlug"]).toBe(PROJECT_SLUG)
    expect(vars["activeStates"]).toEqual(ACTIVE_STATES)
  })

  it("query uses slugId field for project filtering (§17.3 slugId)", async () => {
    const { lastBody } = captureAndMockFetch(singlePageResponse([]))
    await Effect.runPromise(fetchCandidateIssues(ENDPOINT, API_KEY, PROJECT_SLUG, ACTIVE_STATES))
    expect(lastBody().query).toContain("slugId")
  })
})

describe("fetchIssueStatesByIds", () => {
  it("empty array returns [] without calling fetch", async () => {
    let fetchCalled = false
    globalThis.fetch = ((() => {
      fetchCalled = true
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    }) as unknown as typeof globalThis.fetch)

    const result = await Effect.runPromise(fetchIssueStatesByIds(ENDPOINT, API_KEY, []))

    expect(result).toEqual([])
    expect(fetchCalled).toBe(false)
  })

  it("non-empty ids fetches and returns minimal issues", async () => {
    mockFetch({
      data: {
        issues: {
          nodes: [{ id: "id-1", identifier: "SYM-1", state: { name: "Done" } }],
        },
      },
    })

    const result = await Effect.runPromise(
      fetchIssueStatesByIds(ENDPOINT, API_KEY, ["id-1"])
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.state).toBe("Done")
  })

  it("query uses GraphQL ID typing [ID!] (§17.3 [ID!] typing)", async () => {
    const { lastBody } = captureAndMockFetch({
      data: { issues: { nodes: [] } },
    })
    await Effect.runPromise(fetchIssueStatesByIds(ENDPOINT, API_KEY, ["id-1"]))
    expect(lastBody().query).toContain("[ID!]")
  })
})

describe("fetchIssuesByStates", () => {
  it("empty array returns [] without calling fetch", async () => {
    let fetchCalled = false
    globalThis.fetch = ((() => {
      fetchCalled = true
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    }) as unknown as typeof globalThis.fetch)

    const result = await Effect.runPromise(fetchIssuesByStates(ENDPOINT, API_KEY, PROJECT_SLUG, []))

    expect(result).toEqual([])
    expect(fetchCalled).toBe(false)
  })
})

describe("error handling", () => {
  it("GraphQL errors response fails with linear_graphql_errors", async () => {
    globalThis.fetch = ((() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ errors: [{ message: "Unauthorized" }] }),
      } as Response)) as unknown as typeof globalThis.fetch)

    const error = await Effect.runPromise(
      Effect.flip(fetchCandidateIssues(ENDPOINT, API_KEY, PROJECT_SLUG, ACTIVE_STATES))
    )

    expect(error._tag).toBe("TrackerError")
    expect(error.code).toBe("linear_graphql_errors")
  })

  it("HTTP 401 response fails with linear_api_status", async () => {
    mockFetchError(401, "Unauthorized")

    const error = await Effect.runPromise(
      Effect.flip(fetchCandidateIssues(ENDPOINT, API_KEY, PROJECT_SLUG, ACTIVE_STATES))
    )

    expect(error._tag).toBe("TrackerError")
    expect(error.code).toBe("linear_api_status")
  })

  it("network error fails with linear_api_request (§17.3 request error)", async () => {
    globalThis.fetch = ((() =>
      Promise.reject(new Error("Network connection failed"))
    ) as unknown as typeof globalThis.fetch)

    const error = await Effect.runPromise(
      Effect.flip(fetchCandidateIssues(ENDPOINT, API_KEY, PROJECT_SLUG, ACTIVE_STATES))
    )

    expect(error._tag).toBe("TrackerError")
    expect(error.code).toBe("linear_api_request")
  })

  it("response with no data field fails with linear_unknown_payload (§17.3 malformed payload)", async () => {
    globalThis.fetch = ((() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ noDataField: true }),
      } as Response)
    ) as unknown as typeof globalThis.fetch)

    const error = await Effect.runPromise(
      Effect.flip(fetchCandidateIssues(ENDPOINT, API_KEY, PROJECT_SLUG, ACTIVE_STATES))
    )

    expect(error._tag).toBe("TrackerError")
    expect(error.code).toBe("linear_unknown_payload")
  })
})
