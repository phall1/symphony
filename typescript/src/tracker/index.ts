import { Effect, Layer } from "effect"
import { TrackerClient } from "../services.js"
import {
  fetchCandidateIssues,
  fetchIssueStatesByIds,
  fetchIssuesByStates,
  fetchViewerId,
} from "./linear.js"
import type { ResolvedConfig } from "../types.js"

export { fetchCandidateIssues, fetchIssueStatesByIds, fetchIssuesByStates } from "./linear.js"

export function makeLinearTrackerClientLive(config: ResolvedConfig): Layer.Layer<TrackerClient> {
  const { endpoint, api_key, project_slug, active_states, assignee } = config.tracker

  return Layer.effect(TrackerClient)(
    Effect.gen(function* () {
      let resolvedAssigneeId: string | null = null
      if (assignee === "me") {
        resolvedAssigneeId = yield* Effect.promise(() => fetchViewerId(endpoint, api_key))
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
        fetchIssueStatesByIds: (ids) =>
          fetchIssueStatesByIds(endpoint, api_key, ids),
        fetchIssuesByStates: (states) =>
          fetchIssuesByStates(endpoint, api_key, project_slug, states),
        resolvedAssigneeId,
      }
    })
  )
}
