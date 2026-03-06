import { Layer } from "effect"
import { TrackerClient } from "../services.js"
import {
  fetchCandidateIssues,
  fetchIssueStatesByIds,
  fetchIssuesByStates,
} from "./linear.js"
import type { ResolvedConfig } from "../types.js"

export { fetchCandidateIssues, fetchIssueStatesByIds, fetchIssuesByStates } from "./linear.js"

export function makeLinearTrackerClientLive(config: ResolvedConfig): Layer.Layer<TrackerClient> {
  const { endpoint, api_key, project_slug, active_states } = config.tracker
  return Layer.succeed(TrackerClient, {
    fetchCandidateIssues: () =>
      fetchCandidateIssues(endpoint, api_key, project_slug, active_states),
    fetchIssueStatesByIds: (ids) =>
      fetchIssueStatesByIds(endpoint, api_key, ids),
    fetchIssuesByStates: (states) =>
      fetchIssuesByStates(endpoint, api_key, states),
  })
}
