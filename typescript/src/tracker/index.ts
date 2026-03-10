import { Effect, Layer } from "effect"
import { TrackerClient, WorkflowStore } from "../services.js"
import {
  fetchCandidateIssues,
  fetchIssueStatesByIds,
  fetchIssuesByStates,
  fetchViewerId,
} from "./linear.js"
import type { ResolvedConfig } from "../types.js"

export { fetchCandidateIssues, fetchIssueStatesByIds, fetchIssuesByStates } from "./linear.js"

function makeLinearTrackerClient(config: ResolvedConfig): Effect.Effect<TrackerClient["Service"], never> {
  const { endpoint, api_key, project_slug, active_states, assignee } = config.tracker

  return Effect.gen(function* () {
    let resolvedAssigneeId: string | null = null
    if (assignee === "me") {
      resolvedAssigneeId = yield* fetchViewerId(endpoint, api_key)
      if (resolvedAssigneeId) {
        yield* Effect.logInfo(`Resolved assignee "me" to viewer ID: ${resolvedAssigneeId}`)
      } else {
        yield* Effect.logWarning(`Could not resolve assignee "me" to a viewer ID — assignee routing disabled`)
      }
    } else if (assignee) {
      resolvedAssigneeId = assignee
    }

    return {
      fetchCandidateIssues: () =>
        fetchCandidateIssues(endpoint, api_key, project_slug, active_states),
      fetchIssueStatesByIds: (ids: ReadonlyArray<string>) =>
        fetchIssueStatesByIds(endpoint, api_key, ids),
      fetchIssuesByStates: (states: ReadonlyArray<string>) =>
        fetchIssuesByStates(endpoint, api_key, project_slug, states),
      resolvedAssigneeId,
    }
  })
}

export function makeLinearTrackerClientLive(config: ResolvedConfig): Layer.Layer<TrackerClient> {
  return Layer.effect(TrackerClient)(makeLinearTrackerClient(config))
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
