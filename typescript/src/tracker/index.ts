import { Effect, Layer } from "effect"
import { TrackerClient, WorkflowStore } from "../services.js"
import type { ResolvedConfig } from "../types.js"
import {
  fetchCandidateIssues as linearFetchCandidateIssues,
  fetchIssueStatesByIds as linearFetchIssueStatesByIds,
  fetchIssuesByStates as linearFetchIssuesByStates,
  fetchViewerId as linearFetchViewerId,
} from "./linear.js"
import {
  fetchCandidateIssues as planeFetchCandidateIssues,
  fetchIssueStatesByIds as planeFetchIssueStatesByIds,
  fetchIssuesByStates as planeFetchIssuesByStates,
  fetchProjectIdentifier as planeFetchProjectIdentifier,
  fetchViewerId as planeFetchViewerId,
} from "./plane.js"

export const fetchLinearCandidateIssues = linearFetchCandidateIssues
export const fetchLinearIssueStatesByIds = linearFetchIssueStatesByIds
export const fetchLinearIssuesByStates = linearFetchIssuesByStates
export const fetchPlaneCandidateIssues = planeFetchCandidateIssues
export const fetchPlaneIssueStatesByIds = planeFetchIssueStatesByIds
export const fetchPlaneIssuesByStates = planeFetchIssuesByStates
export const fetchCandidateIssues = linearFetchCandidateIssues
export const fetchIssueStatesByIds = linearFetchIssueStatesByIds
export const fetchIssuesByStates = linearFetchIssuesByStates

function makeLinearTrackerClient(config: ResolvedConfig): Effect.Effect<TrackerClient["Service"], never> {
  const { endpoint, api_key, project_slug, active_states, assignee } = config.tracker

  return Effect.gen(function* () {
    let resolvedAssigneeId: string | null = null
    if (assignee === "me") {
      resolvedAssigneeId = yield* linearFetchViewerId(endpoint, api_key).pipe(
        Effect.catch(() => Effect.succeed(null))
      )
      if (resolvedAssigneeId) {
        yield* Effect.logInfo(`Resolved Linear assignee "me" to viewer ID: ${resolvedAssigneeId}`)
      } else {
        yield* Effect.logWarning(`Could not resolve Linear assignee "me" to a viewer ID — assignee routing disabled`)
      }
    } else if (assignee) {
      resolvedAssigneeId = assignee
    }

    return {
      fetchCandidateIssues: () =>
        linearFetchCandidateIssues(endpoint, api_key, project_slug, active_states),
      fetchIssueStatesByIds: (ids: ReadonlyArray<string>) =>
        linearFetchIssueStatesByIds(endpoint, api_key, ids),
      fetchIssuesByStates: (states: ReadonlyArray<string>) =>
        linearFetchIssuesByStates(endpoint, api_key, project_slug, states),
      resolvedAssigneeId,
    }
  })
}

function makePlaneTrackerClient(config: ResolvedConfig): Effect.Effect<TrackerClient["Service"], never> {
  const {
    endpoint,
    api_key,
    workspace_slug = "",
    project_id = "",
    active_states,
    assignee,
  } = config.tracker

  return Effect.gen(function* () {
    const projectIdentifier = yield* planeFetchProjectIdentifier(
      endpoint,
      api_key,
      workspace_slug,
      project_id,
    ).pipe(
      Effect.map((identifier) => identifier ?? project_id),
      Effect.catch((error) =>
        Effect.logWarning(`Could not resolve Plane project identifier, using project_id instead: ${error.message}`).pipe(
          Effect.as(project_id)
        )
      )
    )

    let resolvedAssigneeId: string | null = null
    if (assignee === "me") {
      resolvedAssigneeId = yield* planeFetchViewerId(endpoint, api_key).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Could not resolve Plane assignee "me": ${error.message}`).pipe(
            Effect.as(null)
          )
        )
      )
      if (resolvedAssigneeId) {
        yield* Effect.logInfo(`Resolved Plane assignee "me" to viewer ID: ${resolvedAssigneeId}`)
      } else {
        yield* Effect.logWarning(`Could not resolve Plane assignee "me" to a viewer ID — assignee routing disabled`)
      }
    } else if (assignee) {
      resolvedAssigneeId = assignee
    }

    return {
      fetchCandidateIssues: () =>
        planeFetchCandidateIssues(
          endpoint,
          api_key,
          workspace_slug,
          project_id,
          projectIdentifier,
          active_states,
        ),
      fetchIssueStatesByIds: (ids: ReadonlyArray<string>) =>
        planeFetchIssueStatesByIds(
          endpoint,
          api_key,
          workspace_slug,
          project_id,
          projectIdentifier,
          ids,
        ),
      fetchIssuesByStates: (states: ReadonlyArray<string>) =>
        planeFetchIssuesByStates(
          endpoint,
          api_key,
          workspace_slug,
          project_id,
          projectIdentifier,
          states,
        ),
      resolvedAssigneeId,
    }
  })
}

export function makeLinearTrackerClientLive(config: ResolvedConfig): Layer.Layer<TrackerClient> {
  return Layer.effect(TrackerClient)(makeLinearTrackerClient(config))
}

export function makePlaneTrackerClientLive(config: ResolvedConfig): Layer.Layer<TrackerClient> {
  return Layer.effect(TrackerClient)(makePlaneTrackerClient(config))
}

export const LinearTrackerClientLive: Layer.Layer<TrackerClient, never, WorkflowStore> = Layer.effect(
  TrackerClient
)(
  Effect.gen(function* () {
    const store = yield* WorkflowStore
    const config = yield* Effect.orDie(store.getResolved())
    return yield* makeLinearTrackerClient(config)
  })
)

export const PlaneTrackerClientLive: Layer.Layer<TrackerClient, never, WorkflowStore> = Layer.effect(
  TrackerClient
)(
  Effect.gen(function* () {
    const store = yield* WorkflowStore
    const config = yield* Effect.orDie(store.getResolved())
    return yield* makePlaneTrackerClient(config)
  })
)

export const TrackerClientLive: Layer.Layer<TrackerClient, never, WorkflowStore> = Layer.effect(
  TrackerClient
)(
  Effect.gen(function* () {
    const store = yield* WorkflowStore
    const config = yield* Effect.orDie(store.getResolved())

    if (config.tracker.kind === "plane") {
      return yield* makePlaneTrackerClient(config)
    }

    return yield* makeLinearTrackerClient(config)
  })
)
