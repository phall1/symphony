import { Effect } from "effect"
import type { Issue, TrackerError, BlockerRef } from "../types.js"

const PAGE_SIZE = 50
const REQUEST_TIMEOUT_MS = 30000

// ─── GraphQL Queries ──────────────────────────────────────────────────────────

const CANDIDATE_ISSUES_QUERY = `
  query CandidateIssues($projectSlug: String!, $activeStates: [String!]!, $first: Int!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $activeStates } }
      }
      first: $first
      after: $after
      orderBy: createdAt
    ) {
      nodes {
        id
        identifier
        title
        description
        priority
        state { name }
        branchName
        url
        labels { nodes { name } }
        createdAt
        updatedAt
        assignee {
          id
        }
        inverseRelations(filter: { type: { eq: "blocks" } }) {
          nodes {
            relatedIssue {
              id
              identifier
              state { name }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

const ISSUES_BY_IDS_QUERY = `
  query IssuesByIds($ids: [ID!]!) {
    issues(filter: { id: { in: $ids } }) {
      nodes {
        id
        identifier
        state { name }
        assignee {
          id
        }
      }
    }
  }
`

const ISSUES_BY_STATES_QUERY = `
  query IssuesByStates($projectSlug: String!, $states: [String!]!, $first: Int!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: $first
      after: $after
    ) {
      nodes {
        id
        identifier
        state { name }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

// ─── Normalization ────────────────────────────────────────────────────────────

function normalizeIssue(node: Record<string, unknown>): Issue {
  const labels = (node["labels"] as { nodes: Array<{ name: string }> } | undefined)?.nodes ?? []
  const relations = (node["inverseRelations"] as { nodes: Array<{ relatedIssue: Record<string, unknown> }> } | undefined)?.nodes ?? []

  const blocked_by: BlockerRef[] = relations.map((r) => {
    const ri = r.relatedIssue
    return {
      id: (ri["id"] as string | null) ?? null,
      identifier: (ri["identifier"] as string | null) ?? null,
      state: ((ri["state"] as { name: string } | null)?.name) ?? null,
    }
  })

  const assigneeId = (node["assignee"] as { id: string } | null | undefined)?.id ?? null

  return {
    id: node["id"] as string,
    identifier: node["identifier"] as string,
    title: (node["title"] as string | null) ?? "",
    description: (node["description"] as string | null) ?? null,
    priority: typeof node["priority"] === "number" ? node["priority"] : null,
    state: ((node["state"] as { name: string } | null)?.name) ?? "",
    branch_name: (node["branchName"] as string | null) ?? null,
    url: (node["url"] as string | null) ?? null,
    assignee_id: assigneeId,
    labels: labels.map((l) => l.name.toLowerCase()),
    blocked_by,
    created_at: node["createdAt"] ? new Date(node["createdAt"] as string) : null,
    updated_at: node["updatedAt"] ? new Date(node["updatedAt"] as string) : null,
  }
}

function normalizeMinimalIssue(node: Record<string, unknown>): Issue {
  return {
    id: node["id"] as string,
    identifier: node["identifier"] as string,
    title: "",
    description: null,
    priority: null,
    state: ((node["state"] as { name: string } | null)?.name) ?? "",
    branch_name: null,
    url: null,
    assignee_id: (node["assignee"] as { id: string } | null | undefined)?.id ?? null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
  }
}

// ─── HTTP Client ──────────────────────────────────────────────────────────────

export async function graphqlRequest(
  endpoint: string,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw { _tag: "TrackerError" as const, code: "linear_api_status" as const, message: `Linear API returned HTTP ${response.status}: ${response.statusText}` }
    }

    const json = await response.json() as Record<string, unknown>

    if (json["errors"]) {
      throw { _tag: "TrackerError" as const, code: "linear_graphql_errors" as const, message: `Linear GraphQL errors: ${JSON.stringify(json["errors"])}`, cause: json["errors"] }
    }

    if (!json["data"]) {
      throw { _tag: "TrackerError" as const, code: "linear_unknown_payload" as const, message: "Linear API returned no data field" }
    }

    return json["data"]
  } catch (error) {
    if (error !== null && typeof error === "object" && "_tag" in error) throw error
    throw { _tag: "TrackerError" as const, code: "linear_api_request" as const, message: `Linear API request failed: ${error instanceof Error ? error.message : String(error)}`, cause: error }
  } finally {
    clearTimeout(timer)
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function fetchCandidateIssues(
  endpoint: string,
  apiKey: string,
  projectSlug: string,
  activeStates: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<Issue>, TrackerError> {
  return Effect.tryPromise({
    try: async () => {
      const issues: Issue[] = []
      let cursor: string | null = null

      while (true) {
        const data = await graphqlRequest(endpoint, apiKey, CANDIDATE_ISSUES_QUERY, {
          projectSlug,
          activeStates: [...activeStates],
          first: PAGE_SIZE,
          after: cursor,
        }) as Record<string, unknown>

        const issuesData = data["issues"] as { nodes: Array<Record<string, unknown>>; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
        for (const node of issuesData.nodes) {
          issues.push(normalizeIssue(node))
        }

        if (!issuesData.pageInfo.hasNextPage) break
        if (!issuesData.pageInfo.endCursor) {
          throw { _tag: "TrackerError", code: "linear_missing_end_cursor", message: "Linear API returned hasNextPage=true but no endCursor" }
        }
        cursor = issuesData.pageInfo.endCursor
      }

      return issues
    },
    catch: (error) => {
      if (error !== null && typeof error === "object" && "_tag" in error) return error as TrackerError
      return { _tag: "TrackerError" as const, code: "linear_api_request" as const, message: String(error), cause: error }
    }
  })
}

export function fetchIssueStatesByIds(
  endpoint: string,
  apiKey: string,
  ids: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<Issue>, TrackerError> {
  if (ids.length === 0) return Effect.succeed([])

  return Effect.tryPromise({
    try: async () => {
      const data = await graphqlRequest(endpoint, apiKey, ISSUES_BY_IDS_QUERY, { ids: [...ids] }) as Record<string, unknown>
      const issuesData = data["issues"] as { nodes: Array<Record<string, unknown>> }
      return issuesData.nodes.map(normalizeMinimalIssue)
    },
    catch: (error) => {
      if (error !== null && typeof error === "object" && "_tag" in error) return error as TrackerError
      return { _tag: "TrackerError" as const, code: "linear_api_request" as const, message: String(error), cause: error }
    }
  })
}

export async function fetchViewerId(endpoint: string, apiKey: string): Promise<string | null> {
  const VIEWER_QUERY = `query SymphonyLinearViewer { viewer { id } }`
  try {
    const data = await graphqlRequest(endpoint, apiKey, VIEWER_QUERY, {}) as Record<string, unknown>
    const viewer = data["viewer"] as { id: string } | null
    return viewer?.id ?? null
  } catch {
    return null
  }
}

export function fetchIssuesByStates(
  endpoint: string,
  apiKey: string,
  projectSlug: string,
  states: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<Issue>, TrackerError> {
  if (states.length === 0) return Effect.succeed([])

  return Effect.tryPromise({
    try: async () => {
      const issues: Issue[] = []
      let cursor: string | null = null

      while (true) {
        const data = await graphqlRequest(endpoint, apiKey, ISSUES_BY_STATES_QUERY, {
          projectSlug,
          states: [...states],
          first: PAGE_SIZE,
          after: cursor,
        }) as Record<string, unknown>

        const issuesData = data["issues"] as { nodes: Array<Record<string, unknown>>; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
        for (const node of issuesData.nodes) {
          issues.push(normalizeMinimalIssue(node))
        }

        if (!issuesData.pageInfo.hasNextPage) break
        if (!issuesData.pageInfo.endCursor) {
          throw { _tag: "TrackerError" as const, code: "linear_missing_end_cursor" as const, message: "Linear API returned hasNextPage=true but no endCursor in fetchIssuesByStates" }
        }
        cursor = issuesData.pageInfo.endCursor
      }

      return issues
    },
    catch: (error) => {
      if (error !== null && typeof error === "object" && "_tag" in error) return error as TrackerError
      return { _tag: "TrackerError" as const, code: "linear_api_request" as const, message: String(error), cause: error }
    }
  })
}
