# [Symphony](Symphony.md) Implementation Plan

Status: Draft
Language: TypeScript (Effect)
Date: 2025-03-05

## Overview

Symphony is a long-running service that polls an issue tracker (Linear), creates isolated
per-issue workspaces, and runs coding agent sessions against them. This plan covers implementing
the full spec in TypeScript with Effect, then extending it with a pluggable agent engine
abstraction so it works with both Codex app-server and OpenCode.

## Why TypeScript + Effect

The spec describes an I/O-bound orchestrator — subprocess management, HTTP requests, file ops,
and timer scheduling. No CPU-intensive work. Effect is purpose-built for this:

- **Fiber** → concurrent worker model (spawn per-issue, cancel on reconciliation)
- **Schedule** → polling loop, exponential backoff, continuation retries
- **Scope/Resource** → deterministic subprocess/session cleanup
- **Layer/Service** → the spec's abstraction levels map 1:1 (Policy, Config, Coordination,
  Execution, Integration, Observability)
- **Typed errors** → the spec defines ~20 error categories; Effect tracks them at the type level
- **Ecosystem** → liquidjs, yaml, chokidar, hono — all mature

## Architecture

### Effect Layer Stack

```
┌─────────────────────────────────────┐
│  CLI / Entrypoint                   │  yargs or @effect/cli
├─────────────────────────────────────┤
│  Observability Layer                │  structured logging, optional HTTP dashboard
├─────────────────────────────────────┤
│  Coordination Layer (Orchestrator)  │  poll loop, dispatch, reconciliation, retry queue
├─────────────────────────────────────┤
│  Execution Layer                    │  AgentEngine service, workspace manager
├─────────────────────────────────────┤
│  Integration Layer                  │  Linear tracker client (GraphQL)
├─────────────────────────────────────┤
│  Configuration Layer                │  WORKFLOW.md loader, typed config, file watcher
├─────────────────────────────────────┤
│  Policy Layer                       │  WORKFLOW.md prompt template (Liquid)
└─────────────────────────────────────┘
```

Each layer is an Effect `Layer` — composable, testable, swappable. The `AgentEngine` is a
Service within the Execution Layer. Swapping Codex for OpenCode is just providing a different
Layer at composition time.

### The AgentEngine Service

In Effect, the equivalent of a Rust trait or Go interface is a **Service** (via `Context.Tag`).
This is native to how Effect does dependency injection — you define a service interface, then
provide concrete implementations as Layers. The orchestrator depends on the abstract
`AgentEngine` service and never knows which implementation is running.

```typescript
// --- Service definition ---

class AgentEngine extends Context.Tag("AgentEngine")<
  AgentEngine,
  {
    createSession(input: {
      workspace: string
      cwd: string
      config: AgentConfig
    }): Effect.Effect<AgentSession, AgentEngineError>
  }
>() {}

interface AgentSession {
  runTurn(input: {
    prompt: string
    title: string
    continuation: boolean
  }): Stream.Stream<AgentEvent, AgentSessionError>

  abort(): Effect.Effect<void>
  dispose(): Effect.Effect<void>

  readonly sessionId: string
  readonly threadId: string
}

type AgentEvent =
  | { type: "session_started"; sessionId: string; pid?: string }
  | { type: "turn_completed"; usage: TokenUsage }
  | { type: "turn_failed"; error: string }
  | { type: "turn_cancelled" }
  | { type: "notification"; message: string }
  | { type: "approval_auto_approved"; description: string }
  | { type: "token_usage"; input: number; output: number; total: number }
  | { type: "rate_limit"; payload: unknown }
  | { type: "stall_heartbeat" }  // for stall detection tracking
  | { type: "other"; raw: unknown }

// --- Implementations are Layers ---

const CodexAgentEngineLive: Layer.Layer<AgentEngine, never, CodexConfig>
const OpenCodeAgentEngineLive: Layer.Layer<AgentEngine, never, OpenCodeConfig>
```

This comes for free with Effect — it's the standard way to do DI. The orchestrator's dispatch
code calls `AgentEngine.createSession(...)` and gets back an `AgentSession` regardless of
whether it's talking to Codex over stdio or OpenCode over HTTP.

## Implementation Phases

### Phase 1: Core with Codex Engine

Implement the full spec with Codex app-server as the agent engine. This is the conformance
target.

#### 1.1 Project Scaffolding

- Bun + TypeScript + Effect
- Package structure:
  ```
  src/
    config/          workflow loader, typed config, file watcher
    tracker/         Linear GraphQL client
    orchestrator/    poll loop, state machine, dispatch, reconciliation
    workspace/       workspace manager, hooks, safety invariants
    engine/
      agent.ts       AgentEngine service definition
      codex/         Codex app-server implementation
    prompt/          Liquid template rendering
    observability/   structured logging, optional HTTP server
    cli/             entry point, arg parsing
  ```
- Effect Layer wiring in `src/main.ts`
- Basic tests with vitest

#### 1.2 Configuration Layer

- WORKFLOW.md loader (YAML front matter + markdown body split)
- Typed config with defaults and `$VAR` env resolution
- `~` path expansion
- Validation (tracker.kind, api_key, project_slug, codex.command)
- File watcher (chokidar) with reload-on-change
- Invalid reload keeps last-known-good config

Key Effect patterns:
- `Config` as a `Ref<WorkflowConfig>` for dynamic reload
- `Schedule.spaced` for poll interval changes
- Typed config errors in the error channel

#### 1.3 Issue Tracker Client (Linear)

- GraphQL client for Linear API
- `fetchCandidateIssues()` — paginated, filtered by project slug + active states
- `fetchIssueStatesByIds()` — reconciliation state refresh
- `fetchIssuesByStates()` — startup terminal cleanup
- Issue normalization (labels lowercase, blockers from inverse relations, priority int-only)
- Error categories: transport, non-200, GraphQL errors, malformed payloads
- 30s network timeout, page size 50

#### 1.4 Workspace Manager

- Deterministic workspace path: `<root>/<sanitized_identifier>`
- Sanitization: replace `[^A-Za-z0-9._-]` with `_`
- Path containment check (workspace must be under root)
- Hook execution: `sh -lc <script>` with timeout
- Hook semantics: after_create (fatal), before_run (fatal), after_run (ignored), before_remove
  (ignored)
- Workspace reuse across runs, cleanup on terminal state

#### 1.5 Prompt Engine

- Liquid template rendering (liquidjs, strict mode)
- Template variables: `issue` (full normalized object), `attempt` (null or int)
- Strict unknown variable/filter checking
- Fallback prompt for empty template body

#### 1.6 Codex Agent Engine

Implement the `AgentEngine` service for Codex app-server:

- Subprocess via `bash -lc <codex.command>` with workspace cwd
- JSON-RPC-like line protocol on stdout
- Startup handshake: `initialize` → `initialized` → `thread/start` → `turn/start`
- Streaming turn: read line-delimited JSON, emit AgentEvents
- Turn completion: `turn/completed`, `turn/failed`, `turn/cancelled`
- Approval auto-approve policy
- User-input-required → hard fail
- Unsupported tool calls → reject and continue
- Timeouts: read_timeout_ms, turn_timeout_ms
- Token accounting from thread/tokenUsage/updated events
- Continuation turns on same thread_id

Effect patterns:
- Subprocess as a `Scope`-managed resource (deterministic cleanup)
- Stdout stream as `Stream.fromAsyncIterable` → JSON parse → AgentEvent mapping
- `Effect.timeout` for turn/read timeouts

#### 1.7 Orchestrator

The core state machine. Single authority over mutable state.

- In-memory state: `running`, `claimed`, `retry_attempts`, `completed`, `codex_totals`,
  `codex_rate_limits`
- State held in an Effect `Ref` — single-writer via Fiber coordination
- Poll loop via `Effect.repeat(Schedule.spaced(pollInterval))`
- Tick sequence: reconcile → validate → fetch candidates → sort → dispatch
- Candidate eligibility: active state, not claimed, not running, slots available, blocker rule
- Dispatch: spawn Fiber per issue, track in running map
- Worker lifecycle: workspace → prompt → agent session → turn loop → cleanup
- Continuation turns within a worker (up to max_turns, re-check issue state between turns)
- Normal exit → continuation retry (1s delay, attempt 1)
- Abnormal exit → exponential backoff: `min(10000 * 2^(attempt-1), max_retry_backoff_ms)`
- Reconciliation: stall detection + tracker state refresh
- Stall detection: `elapsed > stall_timeout_ms` → kill + retry
- Terminal state → kill + clean workspace
- Non-active state → kill, no cleanup

Effect patterns:
- Each worker is a `Fiber` — cancellable, supervised
- `Deferred` for worker completion signals
- `Ref` for orchestrator state mutations
- `Schedule` for retry backoff
- `Queue` for event dispatch

#### 1.8 Observability

- Structured logging with `issue_id`, `issue_identifier`, `session_id`
- Runtime snapshot for monitoring (running rows, retry rows, token totals, rate limits)
- Optional HTTP server (Hono):
  - `GET /api/v1/state` — system state summary
  - `GET /api/v1/<identifier>` — issue-specific debug info
  - `POST /api/v1/refresh` — trigger immediate poll
  - `GET /` — dashboard (server-rendered or static)
- CLI: positional workflow path arg, `--port` for HTTP server

#### 1.9 CLI

- `symphony [path-to-WORKFLOW.md]` — start the service
- `--port <port>` — enable HTTP server
- Default: `./WORKFLOW.md`
- Startup validation → fail fast with operator-visible error
- Graceful shutdown on SIGTERM/SIGINT

### Phase 2: AgentEngine Abstraction

This is mostly already done if Phase 1 uses the `AgentEngine` service correctly. Phase 2 is
about hardening the interface and making it a first-class config option.

#### 2.1 Formalize the AgentEngine interface

- Extract from Codex implementation if any leaky abstractions crept in
- Ensure `AgentEvent` covers all orchestrator needs without Codex-specific fields
- Document the contract: what implementors must provide

#### 2.2 WORKFLOW.md config extension

Extend the `agent` section (or add a new `engine` section) to select the runtime:

```yaml
agent:
  engine: codex              # "codex" | "opencode"
  max_concurrent_agents: 10
  max_turns: 20
  max_retry_backoff_ms: 300000

codex:
  command: codex app-server
  approval_policy: auto-edit
  thread_sandbox: stateless
  turn_sandbox_policy: { type: stateless }
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000

opencode:
  # per-workspace server or shared server
  mode: per-workspace        # "per-workspace" | "shared"
  server_url: null            # only for shared mode
  model: anthropic/claude-sonnet-4-20250514
  agent: build
  port: 0                    # ephemeral port for per-workspace mode
```

The config layer reads `agent.engine` and the orchestrator composes the corresponding Layer at
startup.

### Phase 3: OpenCode Agent Engine

#### 3.1 OpenCode engine implementation

Implement `AgentEngine` for OpenCode using its HTTP API + SSE events:

**Session lifecycle:**
- Create: `POST /session` with directory header set to workspace path
- Send prompt: `POST /session/:id/message` with text parts
- Continuation: another `POST /session/:id/message` on same session
- Abort: `POST /session/:id/abort`
- Dispose: cleanup HTTP resources

**Event streaming:**
- Subscribe to `GET /event` (SSE)
- Filter events by `sessionID`
- Map OpenCode events to `AgentEvent`:
  - `message.part.updated` (tool completions, text) → `notification`
  - `session.status { type: "idle" }` → `turn_completed`
  - `session.error` → `turn_failed`
  - `permission.asked` → auto-approve via `POST /permission/:id`

**Server management (two modes):**

Per-workspace mode (recommended):
- Spawn `opencode serve --port 0` per workspace as a subprocess
- Parse the port from stdout
- SDK client per session
- Kill server when worker ends

Shared mode:
- Connect to a pre-existing opencode server
- Pass workspace directory via `x-opencode-directory` header
- Multiple concurrent sessions on one server

**Token accounting:**
- Extract from session/message metadata via SDK
- Or track from SSE event stream

#### 3.2 Permission/approval bridge

OpenCode has its own permission system. Symphony needs to auto-handle permissions for unattended
operation:

- Subscribe to `permission.asked` events on the SSE stream
- Auto-approve or auto-deny based on Symphony's configured policy
- Reply via `POST /permission/:id` with `{ reply: "approve" }` or `{ reply: "reject" }`
- For `opencode run` compatibility: inject permission rules at session creation time to
  auto-deny questions and plan mode transitions (matching what `run.ts` does)

#### 3.3 OpenCode SDK integration

Use `@opencode-ai/sdk` for type-safe API calls:

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk/v2"

const sdk = createOpencodeClient({
  baseUrl: `http://localhost:${port}`,
  directory: workspacePath,
})

const session = await sdk.session.create({ title: "MT-123: Fix auth bug" })
const events = await sdk.event.subscribe()

await sdk.session.prompt({
  sessionID: session.data.id,
  parts: [{ type: "text", text: renderedPrompt }],
  agent: "build",
  model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
})

for await (const event of events.stream) {
  if (event.type === "session.status" &&
      event.properties.sessionID === session.data.id &&
      event.properties.status.type === "idle") {
    break  // turn complete
  }
  // ... map other events to AgentEvent
}
```

### Phase 4: Testing & Validation

#### 4.1 Core conformance tests (Spec Section 17)

- Workflow/config parsing (17.1)
- Workspace manager and safety (17.2)
- Issue tracker client (17.3)
- Orchestrator dispatch, reconciliation, retry (17.4)
- Codex app-server client (17.5)
- Observability (17.6)
- CLI and host lifecycle (17.7)

#### 4.2 OpenCode engine tests

- Session create/prompt/abort lifecycle
- SSE event mapping
- Permission auto-handling
- Per-workspace server spawn/cleanup
- Shared server mode

#### 4.3 Integration tests

- Real Linear API smoke test (skippable without credentials)
- Real Codex app-server handshake (if available)
- Real OpenCode server lifecycle

## Key Dependencies

```json
{
  "effect": "^3.x",
  "@effect/platform": "^0.x",
  "@effect/cli": "^0.x",
  "liquidjs": "^10.x",
  "yaml": "^2.x",
  "chokidar": "^4.x",
  "hono": "^4.x",
  "@opencode-ai/sdk": "latest",
  "vitest": "^3.x"
}
```

## Open Questions

1. **Per-workspace vs shared OpenCode server**: Per-workspace is simpler (clean isolation) but
   heavier (process per issue). Shared is efficient but needs careful session/directory scoping.
   Start with per-workspace, optimize later.

2. **OpenCode model/provider config**: Where should model selection live — in WORKFLOW.md
   (Symphony-controlled) or in OpenCode's own config? Recommendation: WORKFLOW.md specifies the
   model, Symphony passes it to OpenCode at prompt time.

3. **OpenCode stall detection**: The spec's stall detection uses `last_event_at` from agent
   events. OpenCode's SSE stream emits heartbeats every 10s (`server.heartbeat`). These can
   serve as liveness signals — if no events including heartbeats arrive, the session is stalled.

4. **linear_graphql tool extension**: OpenCode already has its own tool system and MCP
   integration. The `linear_graphql` tool from the spec could be implemented as an OpenCode
   custom tool or MCP server rather than a Symphony-side client tool. Needs design.
