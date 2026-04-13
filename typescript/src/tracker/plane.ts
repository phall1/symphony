import { Effect } from "effect"
import type { BlockerRef, Issue, TrackerError } from "../types.js"
import { TrackerError as TrackerErrorType } from "../types.js"

const PAGE_SIZE = 50
const REQUEST_TIMEOUT_MS = 30000

type PlaneStateNode = {
  readonly id?: string
  readonly name?: string
  readonly group?: string
}

type PlaneAssignee = {
  readonly id?: string
}

type PlaneLabel = {
  readonly name?: string
}

type PlaneIssueNode = {
  readonly id?: string
  readonly name?: string
  readonly title?: string
  readonly description?: string | null
  readonly description_html?: string | null
  readonly priority?: string | number | null
  readonly sequence_id?: number | string | null
  readonly identifier?: string | null
  readonly state?: string | PlaneStateNode | null
  readonly assignees?: ReadonlyArray<PlaneAssignee> | null
  readonly labels?: ReadonlyArray<PlaneLabel> | null
  readonly created_at?: string | null
  readonly updated_at?: string | null
}

type PlaneListResponse<T> = {
  readonly next_page_results?: boolean
  readonly next_cursor?: string | null
  readonly results?: ReadonlyArray<T>
}

type PlaneRelationsResponse = {
  readonly blocked_by?: ReadonlyArray<string>
}

function normalizePlaneEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "")
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`
}

function buildPlaneUrl(
  endpoint: string,
  path: string,
  params?: Record<string, string | number | null | undefined>
): string {
  const url = new URL(`${normalizePlaneEndpoint(endpoint)}${path.startsWith("/") ? path : `/${path}`}`)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

function planeRequest(
  endpoint: string,
  apiKey: string,
  path: string,
  params?: Record<string, string | number | null | undefined>
): Effect.Effect<unknown, TrackerError> {
  return planeRequestWithBody("GET", endpoint, apiKey, path, params)
}

function planeRequestWithBody(
  method: "GET" | "PATCH",
  endpoint: string,
  apiKey: string,
  path: string,
  params?: Record<string, string | number | null | undefined>,
  body?: unknown,
): Effect.Effect<unknown, TrackerError> {
  const url = buildPlaneUrl(endpoint, path, params)

  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method,
          headers: {
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            "X-Api-Key": apiKey,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      catch: (err) =>
        new TrackerErrorType({
          code: "plane_api_request",
          message: `Plane API ${method} request failed: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        }),
    })

    if (!response.ok) {
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () =>
          new TrackerErrorType({
            code: "plane_api_status",
            message: `Plane API returned HTTP ${response.status}: ${response.statusText}`,
          }),
      })

      return yield* Effect.fail(
        new TrackerErrorType({
          code: "plane_api_status",
          message: `Plane API returned HTTP ${response.status}: ${response.statusText}${text ? ` — ${text}` : ""}`,
        })
      )
    }

    const json = yield* Effect.tryPromise({
      try: () => response.json() as Promise<Record<string, unknown>>,
      catch: (err) =>
        new TrackerErrorType({
          code: "plane_api_request",
          message: `Failed to parse Plane JSON response: ${String(err)}`,
          cause: err,
        }),
    })

    return json
  }).pipe(
    Effect.timeout(REQUEST_TIMEOUT_MS),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new TrackerErrorType({
          code: "plane_api_request",
          message: `Request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        })
      )
    )
  )
}

function mapPlanePriority(priority: string | number | null | undefined): number | null {
  if (typeof priority === "number") return priority
  if (typeof priority !== "string") return null

  switch (priority.trim().toLowerCase()) {
    case "urgent":
    case "critical":
      return 1
    case "high":
      return 2
    case "medium":
      return 3
    case "low":
      return 4
    default:
      return null
  }
}

function makePlaneIssueIdentifier(node: PlaneIssueNode, projectIdentifier: string): string {
  const explicitIdentifier = node.identifier?.trim()
  if (explicitIdentifier) return explicitIdentifier

  const sequenceId = node.sequence_id
  if (sequenceId !== null && sequenceId !== undefined && String(sequenceId).trim() !== "") {
    return `${projectIdentifier}-${String(sequenceId)}`
  }

  return node.id?.trim() || ""
}

function expectPlaneListPayload<T>(payload: unknown, message: string): PlaneListResponse<T> {
  if (!payload || typeof payload !== "object" || !("results" in payload) || !Array.isArray((payload as PlaneListResponse<T>).results)) {
    throw new TrackerErrorType({
      code: "plane_unknown_payload",
      message,
      cause: payload,
    })
  }
  return payload as PlaneListResponse<T>
}

function expectPlaneIssuePayload(payload: unknown): PlaneIssueNode {
  if (!payload || typeof payload !== "object" || !(("id" in payload) || ("name" in payload) || ("state" in payload))) {
    throw new TrackerErrorType({
      code: "plane_unknown_payload",
      message: "Plane API returned an unexpected issue payload",
      cause: payload,
    })
  }
  return payload as PlaneIssueNode
}

function expectPlaneRelationsPayload(payload: unknown): PlaneRelationsResponse {
  if (!payload || typeof payload !== "object") {
    throw new TrackerErrorType({
      code: "plane_unknown_payload",
      message: "Plane API returned an unexpected relations payload",
      cause: payload,
    })
  }
  return payload as PlaneRelationsResponse
}

function listPaginated<T>(
  endpoint: string,
  apiKey: string,
  path: string,
  params: Record<string, string | number | null | undefined>,
  message: string,
): Effect.Effect<ReadonlyArray<T>, TrackerError> {
  return Effect.gen(function* () {
    const results: T[] = []
    let cursor: string | null = null

    while (true) {
      const payload: unknown = yield* planeRequest(endpoint, apiKey, path, {
        ...params,
        cursor,
        per_page: PAGE_SIZE,
      })
      const page: PlaneListResponse<T> = expectPlaneListPayload<T>(payload, message)
      results.push(...(page.results ?? []))

      if (!page.next_page_results) break
      if (!page.next_cursor) {
        return yield* Effect.fail(
          new TrackerErrorType({
            code: "plane_missing_next_cursor",
            message: "Plane API returned next_page_results=true but no next_cursor",
          })
        )
      }
      cursor = page.next_cursor
    }

    return results
  }).pipe(
    Effect.catch((error) => (error instanceof TrackerErrorType ? Effect.fail(error) : Effect.die(error)))
  )
}

function listProjectIssues(
  endpoint: string,
  apiKey: string,
  workspaceSlug: string,
  projectId: string,
): Effect.Effect<ReadonlyArray<PlaneIssueNode>, TrackerError> {
  return listPaginated<PlaneIssueNode>(
    endpoint,
    apiKey,
    `/workspaces/${workspaceSlug}/projects/${projectId}/work-items/`,
    { expand: "assignees,labels" },
    "Plane API returned an unexpected work-items payload",
  )
}

function listProjectStates(
  endpoint: string,
  apiKey: string,
  workspaceSlug: string,
  projectId: string,
): Effect.Effect<ReadonlyArray<PlaneStateNode>, TrackerError> {
  return listPaginated<PlaneStateNode>(
    endpoint,
    apiKey,
    `/workspaces/${workspaceSlug}/projects/${projectId}/states/`,
    {},
    "Plane API returned an unexpected states payload",
  )
}

function fetchIssueDetail(
  endpoint: string,
  apiKey: string,
  workspaceSlug: string,
  projectId: string,
  issueId: string,
): Effect.Effect<PlaneIssueNode, TrackerError> {
  return planeRequest(
    endpoint,
    apiKey,
    `/workspaces/${workspaceSlug}/projects/${projectId}/work-items/${issueId}/`,
    { expand: "assignees,labels" },
  ).pipe(
    Effect.map(expectPlaneIssuePayload),
    Effect.catch((error) => (error instanceof TrackerErrorType ? Effect.fail(error) : Effect.die(error))),
  )
}

function fetchIssueBlockedByIds(
  endpoint: string,
  apiKey: string,
  workspaceSlug: string,
  projectId: string,
  issueId: string,
): Effect.Effect<ReadonlyArray<string>, TrackerError> {
  return planeRequest(endpoint, apiKey, `/workspaces/${workspaceSlug}/projects/${projectId}/work-items/${issueId}/relations/`).pipe(
    Effect.map(expectPlaneRelationsPayload),
    Effect.map((payload) => payload.blocked_by ?? []),
    Effect.catch((error) => (error instanceof TrackerErrorType ? Effect.fail(error) : Effect.die(error))),
  )
}

function normalizeStateName(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? ""
}

function getStateId(state: PlaneIssueNode["state"]): string | null {
  if (state && typeof state === "object") {
    return state.id?.trim() || null
  }
  if (typeof state === "string") {
    return state.trim() || null
  }
  return null
}

function dedupeStateNames(stateNames: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const stateName of stateNames) {
    const normalized = normalizeStateName(stateName)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    ordered.push(stateName)
  }
  return ordered
}

function resolveTargetState(
  states: ReadonlyArray<PlaneStateNode>,
  preferredNames: ReadonlyArray<string>,
): PlaneStateNode | null {
  for (const preferredName of dedupeStateNames(preferredNames)) {
    const normalized = normalizeStateName(preferredName)
    const match = states.find((state) => normalizeStateName(state.name) === normalized)
    if (match?.id) return match
  }
  return null
}

function transitionIssueState(
  endpoint: string,
  apiKey: string,
  workspaceSlug: string,
  projectId: string,
  projectIdentifier: string,
  issueId: string,
  preferredStateNames: ReadonlyArray<string>,
): Effect.Effect<Issue | null, TrackerError> {
  return Effect.gen(function* () {
    const [issue, states] = yield* Effect.all([
      fetchIssueDetail(endpoint, apiKey, workspaceSlug, projectId, issueId),
      listProjectStates(endpoint, apiKey, workspaceSlug, projectId),
    ])

    const targetState = resolveTargetState(states, preferredStateNames)
    if (!targetState?.id) return null

    const currentStateId = getStateId(issue.state)
    const stateIndex = buildStateIndex(states)

    if (currentStateId === targetState.id) {
      return normalizePlaneIssue(issue, projectIdentifier, stateIndex)
    }

    const updated = yield* planeRequestWithBody(
      "PATCH",
      endpoint,
      apiKey,
      `/workspaces/${workspaceSlug}/projects/${projectId}/work-items/${issueId}/`,
      undefined,
      { state: targetState.id },
    ).pipe(
      Effect.map(expectPlaneIssuePayload),
      Effect.catch((error) => (error instanceof TrackerErrorType ? Effect.fail(error) : Effect.die(error))),
    )

    return normalizePlaneIssue(updated, projectIdentifier, stateIndex)
  })
}

function buildStateIndex(states: ReadonlyArray<PlaneStateNode>): ReadonlyMap<string, PlaneStateNode> {
  return new Map(
    states
      .filter((state) => typeof state.id === "string" && state.id.trim() !== "")
      .map((state) => [state.id!.trim(), state] as const),
  )
}

function getStateName(
  state: PlaneIssueNode["state"],
  stateIndex: ReadonlyMap<string, PlaneStateNode>,
): string {
  if (state && typeof state === "object") {
    return state.name?.trim() || ""
  }
  if (typeof state === "string") {
    return stateIndex.get(state)?.name?.trim() || ""
  }
  return ""
}

function normalizePlaneIssue(
  node: PlaneIssueNode,
  projectIdentifier: string,
  stateIndex: ReadonlyMap<string, PlaneStateNode>,
  blockedBy: ReadonlyArray<BlockerRef> = [],
): Issue {
  const assignees = node.assignees ?? []
  const labels = node.labels ?? []

  return {
    id: node.id?.trim() || "",
    identifier: makePlaneIssueIdentifier(node, projectIdentifier),
    title: node.name?.trim() || node.title?.trim() || "",
    description: node.description ?? node.description_html ?? null,
    priority: mapPlanePriority(node.priority),
    state: getStateName(node.state, stateIndex),
    branch_name: null,
    url: null,
    assignee_id: assignees[0]?.id?.trim() || null,
    labels: labels.map((label) => label.name?.trim().toLowerCase() || "").filter(Boolean),
    blocked_by: [...blockedBy],
    created_at: node.created_at ? new Date(node.created_at) : null,
    updated_at: node.updated_at ? new Date(node.updated_at) : null,
  }
}

export function fetchProjectIdentifier(
  endpoint: string,
  apiKey: string,
  workspaceSlug: string,
  projectId: string,
): Effect.Effect<string | null, TrackerError> {
  return planeRequest(endpoint, apiKey, `/workspaces/${workspaceSlug}/projects/${projectId}/`).pipe(
    Effect.map((payload) => {
      if (!payload || typeof payload !== "object") {
        throw new TrackerErrorType({
          code: "plane_unknown_payload",
          message: "Plane API returned an unexpected project payload",
          cause: payload,
        })
      }
      return (payload as { identifier?: string | null }).identifier?.trim() || null
    }),
    Effect.catch((error) => (error instanceof TrackerErrorType ? Effect.fail(error) : Effect.die(error))),
  )
}

export function fetchViewerId(endpoint: string, apiKey: string): Effect.Effect<string | null, TrackerError> {
  return planeRequest(endpoint, apiKey, "/users/me/").pipe(
    Effect.map((payload) => {
      if (!payload || typeof payload !== "object") {
        throw new TrackerErrorType({
          code: "plane_unknown_payload",
          message: "Plane API returned an unexpected viewer payload",
          cause: payload,
        })
      }
      return (payload as { id?: string | null }).id?.trim() || null
    }),
    Effect.catch((error) => (error instanceof TrackerErrorType ? Effect.fail(error) : Effect.die(error))),
  )
}

export function fetchCandidateIssues(
  endpoint: string,
  apiKey: string,
  workspaceSlug: string,
  projectId: string,
  projectIdentifier: string,
  activeStates: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<Issue>, TrackerError> {
  return Effect.gen(function* () {
    const [allIssues, states] = yield* Effect.all([
      listProjectIssues(endpoint, apiKey, workspaceSlug, projectId),
      listProjectStates(endpoint, apiKey, workspaceSlug, projectId),
    ])

    const stateIndex = buildStateIndex(states)
    const activeStateSet = new Set(activeStates.map((state) => state.trim().toLowerCase()))
    const candidateNodes = allIssues.filter((issue) => activeStateSet.has(getStateName(issue.state, stateIndex).toLowerCase()))

    const allIssueMap = new Map(
      allIssues.map((issue) => {
        const normalized = normalizePlaneIssue(issue, projectIdentifier, stateIndex)
        return [normalized.id, normalized] as const
      }),
    )

    return yield* Effect.forEach(
      candidateNodes,
      (issue) =>
        fetchIssueBlockedByIds(endpoint, apiKey, workspaceSlug, projectId, issue.id?.trim() || "").pipe(
          Effect.map((blockedIds) => {
            const blockers: BlockerRef[] = blockedIds.map((blockedId) => {
              const known = allIssueMap.get(blockedId)
              return {
                id: blockedId,
                identifier: known?.identifier ?? null,
                state: known?.state ?? null,
              }
            })
            return normalizePlaneIssue(issue, projectIdentifier, stateIndex, blockers)
          }),
        ),
      { concurrency: 4 },
    )
  })
}

export function fetchIssueStatesByIds(
  endpoint: string,
  apiKey: string,
  workspaceSlug: string,
  projectId: string,
  projectIdentifier: string,
  ids: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<Issue>, TrackerError> {
  if (ids.length === 0) return Effect.succeed([])

  return Effect.gen(function* () {
    const states = yield* listProjectStates(endpoint, apiKey, workspaceSlug, projectId)
    const stateIndex = buildStateIndex(states)

    return yield* Effect.forEach(
      ids,
      (id) => fetchIssueDetail(endpoint, apiKey, workspaceSlug, projectId, id).pipe(
        Effect.map((issue) => normalizePlaneIssue(issue, projectIdentifier, stateIndex)),
      ),
      { concurrency: 4 },
    )
  })
}

export function fetchIssuesByStates(
  endpoint: string,
  apiKey: string,
  workspaceSlug: string,
  projectId: string,
  projectIdentifier: string,
  states: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<Issue>, TrackerError> {
  if (states.length === 0) return Effect.succeed([])

  return Effect.gen(function* () {
    const [issues, projectStates] = yield* Effect.all([
      listProjectIssues(endpoint, apiKey, workspaceSlug, projectId),
      listProjectStates(endpoint, apiKey, workspaceSlug, projectId),
    ])

    const stateIndex = buildStateIndex(projectStates)
    const stateSet = new Set(states.map((state) => state.trim().toLowerCase()))

    return issues
      .filter((issue) => stateSet.has(getStateName(issue.state, stateIndex).toLowerCase()))
      .map((issue) => normalizePlaneIssue(issue, projectIdentifier, stateIndex))
  })
}

export function transitionIssueToActive(
  endpoint: string,
  apiKey: string,
  workspaceSlug: string,
  projectId: string,
  projectIdentifier: string,
  activeStates: ReadonlyArray<string>,
  issueId: string,
): Effect.Effect<Issue | null, TrackerError> {
  const preferredStates = [
    "In Progress",
    ...activeStates.filter((state) => normalizeStateName(state) !== "todo"),
    ...activeStates,
  ]

  return transitionIssueState(
    endpoint,
    apiKey,
    workspaceSlug,
    projectId,
    projectIdentifier,
    issueId,
    preferredStates,
  )
}

export function transitionIssueToCompleted(
  endpoint: string,
  apiKey: string,
  workspaceSlug: string,
  projectId: string,
  projectIdentifier: string,
  terminalStates: ReadonlyArray<string>,
  issueId: string,
): Effect.Effect<Issue | null, TrackerError> {
  const preferredStates = ["Done", ...terminalStates]

  return transitionIssueState(
    endpoint,
    apiKey,
    workspaceSlug,
    projectId,
    projectIdentifier,
    issueId,
    preferredStates,
  )
}
