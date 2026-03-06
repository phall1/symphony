# Symphony TypeScript+Effect Implementation

## TL;DR

> **Quick Summary**: Build Symphony — an AI coding agent orchestrator — in TypeScript using the Effect ecosystem, implementing the full SPEC.md conformance spec with Codex as the first agent engine, then adding OpenCode support via a pluggable `AgentEngine` abstraction.
>
> **Deliverables**:
> - `typescript/` directory — standalone Bun+TypeScript+Effect package
> - Phase 1: Full spec-conformant Symphony with Codex engine
> - Phase 2: Hardened `AgentEngine` abstraction + config-driven engine selection
> - Phase 3: OpenCode engine implementation
> - Phase 4: Full vitest conformance test suite (SPEC.md §17)
>
> **Estimated Effort**: XL
> **Parallel Execution**: YES — 5 waves
 > **Critical Path**: T1 (scaffold) → T2+T3 (types/services) → T7 (workspace) → T8+T9 (Codex engine + orchestrator) → T10+T11 (observability + CLI) → T12+T13 (abstraction + OpenCode) → T14–T18 (tests) → TF1–TF4 (final review)

---

## Context

### Original Request
Adapt `SYMPHONY_PLAN.md` into an executable work plan using the Sisyphus/Prometheus system. Implement Symphony in TypeScript+Effect per the 4-phase plan.

### Research Findings
- **Codebase state**: Pure greenfield — no TypeScript exists. Only `elixir/` reference implementation.
- **Reference implementation**: `elixir/lib/symphony_elixir/` — complete, production-ready. Use it as algorithmic reference for state machine logic, reconciliation semantics, retry math, and hook semantics.
- **SPEC.md**: 2110 lines, language-agnostic. Authoritative source of truth. Sections 7, 8, 9, 10, 16 contain the reference algorithms in pseudocode.
- **Effect ecosystem**: `effect@4.0.0-beta.27` (includes platform APIs in v4) + `@effect/platform-bun@4.0.0-beta.27` — use the v4 Command API (from `effect/unstable/process` or `@effect/platform-bun`) for subprocess spawning, NOT raw `Bun.spawn`. Do NOT install `@effect/platform` separately — it's consolidated into `effect` in v4.

### Metis Review — Gaps Addressed
- **Codex protocol version**: Target current `codex app-server` (v2 protocol). Inspect schema via `codex app-server generate-json-schema` if available.
- **Default sandbox posture**: Match Elixir defaults — `thread_sandbox: "workspace-write"`, `approval_policy: { reject: { sandbox_approval: true, rules: true, mcp_elicitations: true } }`, `turn_sandbox_policy: workspaceWrite rooted at workspace path`. Documented in implementation.
- **Effect subprocess strategy**: Use `@effect/platform-bun` `Command` + `CommandExecutor` for managed subprocess lifecycle inside a `Scope`.
- **Pre-dispatch re-validation**: Include in tick sequence per spec §6.3.
- **All 4 approval method names**: `item/approval/request`, legacy `approval-request`, `item/command/execute/approval`, `item/patch/approval` — handle all.
- **Stdout line buffering**: Explicit buffering logic for partial JSON lines from stdout.
- **`agent.max_turns` in worker loop**: Tracked in worker, enforced per §7.1.
- **`linear_graphql` tool**: Phase 1 EXCLUDED — extension only, implement in Phase 2 if desired.
- **OpenCode `x-opencode-directory` header**: Required for session directory scoping.
- **Stall heartbeat**: Map OpenCode SSE `server.heartbeat` events to `stall_heartbeat` AgentEvent.
- **TypeScript location**: `typescript/` directory at repo root (sibling to `elixir/`).

### Effect v4 Beta — Critical API Changes (effect@4.0.0-beta.27)

> **THIS IS NOT EFFECT V3. The entire service definition API has changed. Every task MUST use v4 APIs.**

**Versioning — unified across ecosystem**:
- All packages share one version: `effect@4.0.0-beta.27`, `@effect/platform-bun@4.0.0-beta.27`
- Do NOT mix v3 package versions

**Package consolidation — `@effect/platform` is now INSIDE `effect`**:
- `HttpServer`, `HttpClient`, `Command`, `CommandExecutor`, `FileSystem`, etc. → all in `effect` package
- Import from `effect/unstable/http`, `effect/unstable/process` etc. (unstable modules)
- `@effect/platform-bun` still exists as a separate package (same version) for Bun-specific implementations

**Service definition — `Context.Tag` → `ServiceMap.Service`**:
```typescript
// ❌ v3 (WRONG — will not compile on v4)
class MyService extends Context.Tag("MyService")<MyService, { ... }>() {}

// ✅ v4 (CORRECT)
import { ServiceMap } from "effect"
class MyService extends ServiceMap.Service<MyService, { ... }>()("MyService") {}
```

**Service access — no more static proxy accessors**:
```typescript
// ❌ v3 (WRONG)
const result = MyService.someMethod()

// ✅ v4 — use yield* in generator or .use()
const result = Effect.gen(function*() {
  const svc = yield* MyService
  return yield* svc.someMethod()
})
// or one-liner:
const result = MyService.use(svc => svc.someMethod())
```

**Layer naming convention — `.Default` → `.layer`**:
```typescript
// v3: MyService.Default
// v4: MyService.layer (for primary layer), MyService.layerTest (for test variant)
static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(...))
```

**Forking — renamed**:
```typescript
// ❌ v3
Effect.fork(effect)       // → child fiber
Effect.forkDaemon(effect) // → detached fiber

// ✅ v4
Effect.forkChild(effect)   // → child of current fiber
Effect.forkDetach(effect)  // → detached from parent lifecycle
```

**`Effect.Service` removed** — use `ServiceMap.Service` with `make` option:
```typescript
// ✅ v4 with inline constructor
class Logger extends ServiceMap.Service<Logger>()("Logger", {
  make: Effect.gen(function*() {
    return { log: (msg: string) => Effect.log(msg) }
  })
}) {
  static readonly layer = Layer.effect(this, this.make)
}
```

**`FiberRef` → `ServiceMap.Reference`**:
```typescript
// v4
const LogLevel = ServiceMap.Reference<"info" | "warn">("LogLevel", {
  defaultValue: () => "info" as const
})
```

**`effect/unstable/*` imports** — modules like HTTP, CLI, Process, Schema live here in v4:
- HTTP server: `import { HttpRouter, HttpServer } from "effect/unstable/http"`
- Process/Command: `import { Command } from "effect/unstable/process"`
- These are marked unstable — may change in future betas

**Practical guidance for implementing agent**:
- Read `https://raw.githubusercontent.com/Effect-TS/effect-smol/main/MIGRATION.md` for the full guide
- Read `https://raw.githubusercontent.com/Effect-TS/effect-smol/main/migration/services.md` for service patterns
- Read `https://raw.githubusercontent.com/Effect-TS/effect-smol/main/migration/forking.md` for fiber patterns
- Before writing any Effect code, verify imports compile against `effect@4.0.0-beta.27` exactly

---

## Work Objectives

### Core Objective
Implement a fully spec-conformant Symphony orchestrator in TypeScript+Effect, housed in `typescript/` at the repo root, covering Phases 1–4 of SYMPHONY_PLAN.md.

### Concrete Deliverables
- `typescript/package.json` — Bun project with all dependencies
- `typescript/src/` — Full source tree (config, tracker, orchestrator, workspace, engine, prompt, observability, cli)
- `typescript/src/main.ts` — Effect Layer composition root
- `typescript/vitest.config.ts` + `typescript/src/**/*.test.ts` — conformance test suite
- Running `bun run symphony WORKFLOW.md` starts the service

### Definition of Done
- [ ] `bun test` passes all conformance tests in `typescript/`
- [ ] `bun run build` produces a working binary
- [ ] `bun run symphony ./elixir/WORKFLOW.md --port 3456` starts and polls Linear

### Must Have
- All §18.1 Required for Conformance items
- Effect Layer architecture matching SYMPHONY_PLAN.md layer stack
- `AgentEngine` as `Context.Tag` service with Codex and OpenCode implementations
- Zero mutable state outside Effect `Ref`
- All workspace safety invariants (§9.5)

### Must NOT Have (Guardrails)
- No mutable global variables — all state in Effect `Ref`
- No `process.exit()` calls in library code — only in CLI entrypoint
- No `as any` without a comment explaining why
- No `console.log` in production code — use the Effect Logger
- No tracker write APIs in orchestrator — reads only; writes are agent-tool responsibility
- No TypeScript files outside `typescript/` directory
- No touching `elixir/` directory
- No `linear_graphql` tool in Phase 1
- No dashboard HTML in Phase 1 — JSON API only (GET / returns 200 with basic text)
- No `@effect/cli` — use plain `process.argv` parsing for CLI simplicity

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: NO (greenfield)
- **Automated tests**: YES (Tests-after, vitest)
- **Framework**: vitest (as per SYMPHONY_PLAN.md)
- **TDD**: No — implement then test. Spec conformance tests are the acceptance gate.

### QA Policy
Every task includes agent-executed QA scenarios.

- **Unit/integration**: `bun test` in `typescript/`
- **CLI smoke**: `bash -c "..."` via interactive_bash or Bash tool
- **API**: `curl` against running HTTP server
- **Process lifecycle**: spawn via `Bash` tool, capture stdout

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Immediate — scaffolding + types + foundations):
├── T1: Project scaffolding (package.json, tsconfig, vitest, bun scripts)
├── T2: Shared types + domain model (Issue, WorkflowDef, ServiceConfig, AgentEvent, etc.)
├── T3: Effect service definitions (AgentEngine tag, Layer interfaces, error types)
└── T4: Prompt engine (liquidjs Liquid renderer, strict mode, fallback prompt)

Wave 2 (After Wave 1 — independent integrations):
├── T5: Configuration layer (WORKFLOW.md loader, YAML parser, $VAR + ~ expansion, chokidar watcher, validation, dynamic reload)
├── T6: Linear tracker client (GraphQL HTTP client, fetchCandidateIssues, fetchIssueStatesByIds, fetchIssuesByStates, normalization, pagination)
└── T7: Workspace manager (sanitize, path containment, mkdir, hooks via sh -lc, timeout, hook semantics)

Wave 3 (After T2+T5+T6+T7 — engine + orchestrator):
├── T8: Codex agent engine (subprocess via @effect/platform-bun Command, JSON-RPC handshake, stdout line buffering, streaming, approval, tool rejection, timeouts, token accounting, AgentEngine Layer)
└── T9: Orchestrator core (Effect Ref state, poll loop via Schedule, tick sequence, candidate selection, concurrency control, retry queue + backoff, stall detection, reconciliation, startup cleanup, fiber-per-worker dispatch)

Wave 4 (After T8+T9 — HTTP + CLI + OpenCode):
├── T10: Observability + HTTP server (structured Effect Logger, Hono server, /api/v1/state, /api/v1/:id, POST /api/v1/refresh, runtime snapshot)
├── T11: CLI entrypoint (process.argv parsing, SIGTERM/SIGINT, Layer composition in main.ts, startup validation fail-fast)
├── T12: AgentEngine abstraction hardening (formalize interface, ensure no Codex leakage, document contract, WORKFLOW.md agent.engine config field)
└── T13: OpenCode agent engine (HTTP client, POST /session, POST /session/:id/message, GET /event SSE, permission bridge, per-workspace server spawn, shared mode, token accounting, OpenCode Layer)

Wave 5 (After T10+T11+T12+T13 — tests):
├── T14: Config + workspace + tracker tests (§17.1 + §17.2 + §17.3 conformance)
├── T15: Orchestrator + retry + reconciliation tests (§17.4 conformance)
├── T16: Codex engine tests (§17.5 conformance, mock subprocess)
├── T17: Observability + CLI tests (§17.6 + §17.7 conformance)
└── T18: OpenCode engine tests (§17 extension conformance, mock HTTP server)

Wave FINAL (After all — parallel review):
├── TF1: Plan compliance audit (oracle)
├── TF2: Code quality review (unspecified-high)
├── TF3: Real QA — start service, hit API, verify logs (unspecified-high)
└── TF4: Scope fidelity check (deep)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| T1 | — | ALL |
| T2 | T1 | T3, T4, T5, T6, T7, T8, T9 |
| T3 | T1, T2 | T8, T9, T12, T13 |
| T4 | T1, T2 | T9 |
| T5 | T1, T2 | T9, T11 |
| T6 | T1, T2 | T9 |
| T7 | T1, T2 | T9 |
| T8 | T1, T2, T3, T5 | T9, T10, T12, T16 |
| T9 | T1, T2, T3, T4, T5, T6, T7, T8 | T10, T11, T15 |
| T10 | T1, T8, T9 | T11, T17 |
| T11 | T1, T5, T9, T10 | TF1-TF4 |
| T12 | T1, T2, T3, T8 | T13 |
| T13 | T1, T2, T3, T12 | T18 |
| T14 | T5, T6, T7 | TF2 |
| T15 | T9 | TF2 |
| T16 | T8 | TF2 |
| T17 | T10, T11 | TF2 |
| T18 | T13 | TF2 |
| TF1-TF4 | ALL | — |

### Agent Dispatch Summary

- **Wave 1**: T1 → `quick`, T2 → `quick`, T3 → `quick`, T4 → `quick`
- **Wave 2**: T5 → `unspecified-high`, T6 → `unspecified-high`, T7 → `unspecified-high`
- **Wave 3**: T8 → `deep`, T9 → `deep`
- **Wave 4**: T10 → `unspecified-high`, T11 → `quick`, T12 → `unspecified-high`, T13 → `deep`
- **Wave 5**: T14 → `unspecified-high`, T15 → `unspecified-high`, T16 → `unspecified-high`, T17 → `unspecified-high`, T18 → `unspecified-high`
- **Final**: TF1 → `oracle`, TF2 → `unspecified-high`, TF3 → `unspecified-high`, TF4 → `deep`

---

## TODOs

- [x] T1. Project Scaffolding

  **What to do**:
  - Create `typescript/` directory at repo root (sibling to `elixir/`)
  - `typescript/package.json`: name `symphony`, private, scripts: `start`/`build`/`typecheck`/`test`/`symphony`
  - Dependencies: `effect@4.0.0-beta.27`, `@effect/platform-bun@4.0.0-beta.27`, `liquidjs`, `yaml`, `chokidar`, `hono`
  - DevDependencies: `typescript`, `@types/bun`, `vitest`, `@effect/vitest@4.0.0-beta.27`
  - Note: `@effect/platform` is now consolidated INTO `effect` in v4 — do NOT install it separately
  - `typescript/tsconfig.json`: `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`, `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`
  - `typescript/vitest.config.ts`: basic vitest config, timeout 10000ms
  - `typescript/src/` directory structure:
    ```
    src/
      config/
      tracker/
      orchestrator/
      workspace/
      engine/
        agent.ts        (AgentEngine service definition)
        codex/
        opencode/
      prompt/
      observability/
      cli/
      main.ts
    ```
  - `typescript/.gitignore`: `node_modules/`, `dist/`, `.env`
  - `typescript/README.md`: one-paragraph description + `bun install && bun run symphony WORKFLOW.md`
  - Run `bun install` to verify lockfile generates cleanly

  **Must NOT do**:
  - Do not create any implementation files beyond scaffolding
  - Do not use `npm` or `yarn` — Bun only
  - Do not add `@effect/cli` — plain argv parsing only

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Pure file creation, no logic, clear spec
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1 — but must complete FIRST as all others depend on it
  - **Blocks**: ALL tasks
  - **Blocked By**: None

  **References**:
  - `SYMPHONY_PLAN.md:118-135` — exact package structure and dependencies list
  - `elixir/mix.exs` — see dependency version ranges for inspiration
  - Effect ecosystem: `effect ^3.x`, `@effect/platform ^0.x`, `@effect/platform-bun ^0.x`
  - `typescript/` must be at `typescript/` relative to `/Users/phall/workspace/symphony/`

  **Acceptance Criteria**:
  - [ ] `typescript/package.json` exists with all required dependencies
  - [ ] `typescript/tsconfig.json` with strict mode + exactOptionalPropertyTypes
  - [ ] `typescript/vitest.config.ts` exists
  - [ ] All `src/` subdirectories created (config, tracker, orchestrator, workspace, engine, engine/codex, engine/opencode, prompt, observability, cli)
  - [ ] `bun install` exits 0 from `typescript/`

  **QA Scenarios**:
  ```
  Scenario: Directory structure is correct
    Tool: Bash
    Steps:
      1. ls typescript/src/ | sort
      2. Assert output includes: cli config engine observability orchestrator prompt tracker workspace
    Expected Result: All 8 subdirectories present
    Evidence: .sisyphus/evidence/t1-dir-structure.txt

  Scenario: Bun install succeeds
    Tool: Bash
    Preconditions: typescript/ directory exists with package.json
    Steps:
      1. cd typescript && bun install
      2. Assert exit code 0
      3. Assert bun.lockb exists
    Expected Result: Clean install, no errors
    Evidence: .sisyphus/evidence/t1-bun-install.txt
  ```

  **Commit**: YES (after T1 alone)
  - Message: `chore(typescript): initialize bun+typescript+effect project scaffold`
  - Files: `typescript/`

- [x] T2. Shared Types + Domain Model

  **What to do**:
  - Create `typescript/src/types.ts` — all domain types from SPEC.md §4
  - `Issue`: id, identifier, title, description, priority, state, branch_name, url, labels, blocked_by (BlockerRef[]), created_at, updated_at — all optional nullable as per spec
  - `BlockerRef`: id, identifier, state (all string | null)
  - `WorkflowDefinition`: config (WorkflowConfig), prompt_template (string)
  - `WorkflowConfig`: full front matter shape — tracker, polling, workspace, hooks, agent, codex, server (optional extension)
  - `TrackerConfig`, `PollingConfig`, `WorkspaceConfig`, `HooksConfig`, `AgentConfig`, `CodexConfig`, `ServerConfig`
  - `OrchestratorState`: running (Map<string, RunningEntry>), claimed (Set<string>), retry_attempts (Map<string, RetryEntry>), completed (Set<string>), codex_totals (TokenTotals), codex_rate_limits (unknown | null), poll_interval_ms (number), max_concurrent_agents (number)
  - `RunningEntry`: full fields from SPEC.md §4.1.6 (session_id, thread_id, turn_id, codex_app_server_pid, last_codex_event, last_codex_timestamp, last_codex_message, token fields, turn_count, started_at, issue, identifier, worker_fiber)
  - `RetryEntry`: issue_id, identifier, attempt, due_at_ms, error, timer_handle
  - `LiveSession`: session_id, thread_id, turn_id + all token fields from §4.1.6
  - `TokenTotals`: input_tokens, output_tokens, total_tokens, seconds_running
  - `RunAttemptStatus` union type: "PreparingWorkspace" | "BuildingPrompt" | "LaunchingAgentProcess" | "InitializingSession" | "StreamingTurn" | "Finishing" | "Succeeded" | "Failed" | "TimedOut" | "Stalled" | "CanceledByReconciliation"
  - `AgentEvent` discriminated union (from SYMPHONY_PLAN.md lines 88-98): session_started, turn_completed, turn_failed, turn_cancelled, notification, approval_auto_approved, token_usage, rate_limit, stall_heartbeat, other
  - Typed error types: `SymphonyError` union — `WorkflowError` | `ConfigError` | `TrackerError` | `WorkspaceError` | `AgentError` | `PromptError`
  - Export all from `typescript/src/types.ts`

  **Must NOT do**:
  - Do not implement any logic — types only
  - Do not use `any` for domain types — use `unknown` where truly untyped
  - Do not create separate files per type — one `types.ts` is fine

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Pure TypeScript type definitions, no logic
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T3, T4 once T1 done)
  - **Parallel Group**: Wave 1
  - **Blocks**: T3, T4, T5, T6, T7, T8, T9
  - **Blocked By**: T1

  **References**:
  - `SPEC.md:139-264` — complete entity definitions (§4.1.1 through §4.1.8)
  - `SYMPHONY_PLAN.md:86-99` — AgentEvent discriminated union
  - `elixir/lib/symphony_elixir/orchestrator.ex` — see how state fields are named/typed in Elixir reference
  - `SPEC.md:278` — session_id is `"<thread_id>-<turn_id>"`

  **Acceptance Criteria**:
  - [ ] `typescript/src/types.ts` exists with all domain types
  - [ ] `bun run typecheck` exits 0 (no TS errors in types.ts)
  - [ ] All SPEC.md §4 entities represented

  **QA Scenarios**:
  ```
  Scenario: TypeScript compiles with no errors
    Tool: Bash
    Steps:
      1. cd typescript && bun run typecheck
      2. Assert exit code 0
    Expected Result: No TypeScript errors
    Evidence: .sisyphus/evidence/t2-typecheck.txt

  Scenario: All required types exist
    Tool: Bash
    Steps:
      1. grep -c "export type\|export interface" typescript/src/types.ts
      2. Assert count >= 15 (Issue, BlockerRef, WorkflowDefinition, WorkflowConfig, OrchestratorState, RunningEntry, RetryEntry, TokenTotals, AgentEvent, etc.)
    Expected Result: >= 15 exported types/interfaces
    Evidence: .sisyphus/evidence/t2-types-count.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [x] T3. Effect Service Definitions

  **What to do**:
  - Create `typescript/src/engine/agent.ts` — `AgentEngine` service and `AgentSession` interface (verbatim from SYMPHONY_PLAN.md lines 63-103)
  - `AgentEngine` via `Context.Tag("AgentEngine")` — `createSession(input: {workspace, cwd, config}) => Effect<AgentSession, AgentEngineError>`
  - `AgentSession` interface: `runTurn(input: {prompt, title, continuation}) => Stream<AgentEvent, AgentSessionError>`, `abort() => Effect<void>`, `dispose() => Effect<void>`, `sessionId: string`, `threadId: string`
  - `AgentEngineError`, `AgentSessionError` typed errors
  - Create `typescript/src/services.ts` — all other Effect service tags:
    - `WorkflowStore` service tag — `get() => Effect<WorkflowDefinition, WorkflowError>`, `watch() => Stream<WorkflowDefinition, WorkflowError>`
    - `TrackerClient` service tag — `fetchCandidateIssues() => Effect<Issue[], TrackerError>`, `fetchIssueStatesByIds(ids: string[]) => Effect<Issue[], TrackerError>`, `fetchIssuesByStates(states: string[]) => Effect<Issue[], TrackerError>`
    - `WorkspaceManager` service tag — `createForIssue(identifier: string) => Effect<Workspace, WorkspaceError>`, `removeForIssue(identifier: string) => Effect<void, WorkspaceError>`
    - `PromptEngine` service tag — `render(template: string, issue: Issue, attempt: number | null) => Effect<string, PromptError>`
    - `OrchestratorRef` service tag — `Effect.Ref<OrchestratorState>` wrapper
  - All service tags use `Context.Tag` pattern from Effect
  - Error types from `types.ts` used throughout

  **Must NOT do**:
  - Do not implement services yet — interfaces only
  - Do not import from non-existent modules

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Interface/tag definitions only, no implementation
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T2, T4)
  - **Parallel Group**: Wave 1
  - **Blocks**: T8, T9, T12, T13
  - **Blocked By**: T1, T2

  **References**:
  - `SYMPHONY_PLAN.md:56-104` — exact AgentEngine service definition and implementation layer pattern
  - Effect `Context.Tag` docs — `class MyService extends Context.Tag("MyService")<MyService, { ... }>() {}`
  - `typescript/src/types.ts` — import AgentEvent, Issue, WorkflowDefinition, SymphonyError types

  **Acceptance Criteria**:
  - [ ] `typescript/src/engine/agent.ts` with `AgentEngine` Context.Tag
  - [ ] `typescript/src/services.ts` with all 5 service tags
  - [ ] `bun run typecheck` exits 0

  **QA Scenarios**:
  ```
  Scenario: Service files compile cleanly
    Tool: Bash
    Steps:
      1. cd typescript && bun run typecheck
      2. Assert exit code 0
    Expected Result: No errors
    Evidence: .sisyphus/evidence/t3-typecheck.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [x] T4. Prompt Engine

  **What to do**:
  - Create `typescript/src/prompt/index.ts` — `PromptEngine` Layer implementation
  - Use `liquidjs` `Liquid` class with `strictVariables: true`, `strictFilters: true`
  - `render(template, issue, attempt)`:
    - If template is empty/blank → return `"You are working on an issue from Linear."` (SPEC.md §5.4 fallback)
    - Otherwise: render `template` with `{ issue, attempt }` context
    - Issue object keys must be strings for template compatibility
    - Nested arrays/maps (labels, blockers) must be preserved
    - On unknown variable → throw `PromptError` with `template_render_error`
    - On parse error → throw `PromptError` with `template_parse_error`
  - Provide `PromptEngineLive: Layer<PromptEngine>` for composition
  - Write unit test: `typescript/src/prompt/index.test.ts`
    - Test: renders `{{ issue.identifier }}` → `"MT-123"`
    - Test: renders `{{ attempt }}` → `null` on first run, `1` on retry
    - Test: unknown variable `{{ issue.foo }}` → fails with PromptError
    - Test: empty template → fallback prompt returned
    - Test: labels array iteration `{% for label in issue.labels %}`

  **Must NOT do**:
  - Do not use non-strict Liquid mode
  - Do not silently swallow template errors

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small focused module, library integration
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T2, T3)
  - **Parallel Group**: Wave 1
  - **Blocks**: T9
  - **Blocked By**: T1, T2

  **References**:
  - `SPEC.md:446-484` — §5.4 Prompt Template Contract, §5.5 error classes
  - `SPEC.md:1222-1253` — §12 Prompt Construction: inputs, rendering rules, retry semantics
  - `SYMPHONY_PLAN.md:174-177` — liquidjs strict mode description
  - `elixir/lib/symphony_elixir/prompt_builder.ex` — reference for how template context is assembled
  - `liquidjs` npm docs — `Liquid({ strictVariables: true, strictFilters: true })`

  **Acceptance Criteria**:
  - [ ] `typescript/src/prompt/index.ts` exports `PromptEngineLive` Layer
  - [ ] All 5 unit tests pass: `bun test typescript/src/prompt/`
  - [ ] Unknown variable throws PromptError (not silently empty string)

  **QA Scenarios**:
  ```
  Scenario: Template renders correctly with issue context
    Tool: Bash
    Steps:
      1. bun test typescript/src/prompt/ --reporter=verbose
      2. Assert exit code 0
      3. Assert "5 tests passed" in output
    Expected Result: All prompt tests pass
    Evidence: .sisyphus/evidence/t4-prompt-tests.txt

  Scenario: Strict mode rejects unknown variables
    Tool: Bash
    Steps:
      1. Create a tiny test script that runs Liquid with {{ issue.nonexistent }} and catches the error
      2. Assert error message contains "template_render_error" or similar
    Expected Result: Error thrown, not empty string
    Evidence: .sisyphus/evidence/t4-strict-mode.txt
  ```

  **Commit**: NO (groups with Wave 1)

> **⚠️ Effect v4 Note for T3**: Use `ServiceMap.Service` NOT `Context.Tag`. See "Effect v4 Beta — Critical API Changes" section above. Layer naming: `.layer` not `.Default`. No static accessors — use `yield*` in generators.

- [ ] T5. Configuration Layer

  **What to do**:
  - Create `typescript/src/config/index.ts` — `WorkflowStore` Layer implementation
  - **WORKFLOW.md parsing** (`typescript/src/config/loader.ts`):
    - Read file → if starts with `---`, split at second `---` as YAML front matter + prompt body
    - If no front matter → empty config, entire file is prompt_template
    - Parse YAML front matter with `yaml` package → must be a plain object (not array/string) → else `workflow_front_matter_not_a_map` error
    - Trim prompt body
    - Return `WorkflowDefinition`
  - **Config resolution** (`typescript/src/config/resolve.ts`):
    - `$VAR` resolution: if value matches `^\$[A-Z_][A-Z0-9_]*$` → `process.env[VAR]` (empty string treated as missing)
    - `~` expansion: replace leading `~` with `os.homedir()`
    - Apply to: `tracker.api_key`, `tracker.endpoint`, `workspace.root`
    - `codex.command` is a shell string — do NOT expand `$VAR` (shell does it)
    - Defaults applied per SPEC.md §6.4 cheat sheet (all defaults listed)
    - `tracker.active_states` / `terminal_states`: accept list or comma-separated string → split and trim
    - `agent.max_concurrent_agents_by_state`: normalize keys (trim + lowercase), ignore non-positive values
  - **Validation** (`typescript/src/config/validate.ts`):
    - `tracker.kind` is present and is `"linear"` → else `ConfigError("unsupported_tracker_kind")`
    - `tracker.api_key` is non-empty after `$` resolution → else `ConfigError("missing_tracker_api_key")`
    - `tracker.project_slug` is present → else `ConfigError("missing_tracker_project_slug")`
    - `codex.command` is non-empty → else `ConfigError`
    - Return typed `ConfigError[]` list
  - **File watcher** (`typescript/src/config/watcher.ts`):
    - Use `chokidar` to watch the WORKFLOW.md path
    - On change: re-read → re-parse → re-validate → if valid, update `Ref<WorkflowDefinition>` → emit
    - If invalid: log error, keep last-known-good config (do NOT update Ref)
    - Use `Effect.Ref<WorkflowDefinition>` as the live config store
  - `WorkflowStoreLive` Layer: wraps loader + resolver + watcher
  - Unit tests `typescript/src/config/index.test.ts`:
    - Parses YAML front matter correctly
    - Empty WORKFLOW.md → fallback prompt
    - `$LINEAR_API_KEY` resolves from env
    - `~` expands to homedir
    - Missing `tracker.kind` → validation error
    - Comma-separated `active_states` → array
    - Invalid reload → keeps last-known-good

  **Must NOT do**:
  - Do not expand `$VAR` inside `codex.command`
  - Do not crash on invalid reload — keep last-known-good
  - Do not apply `~` to URI fields

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Multiple sub-components, complex semantics, dynamic reload semantics
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T6, T7)
  - **Parallel Group**: Wave 2
  - **Blocks**: T9, T11
  - **Blocked By**: T1, T2

  **References**:
  - `SPEC.md:296-579` — §5 WORKFLOW.md spec, §6 Configuration spec (full cheat sheet §6.4)
  - `SPEC.md:504-524` — §6.2 Dynamic reload semantics
  - `SPEC.md:525-549` — §6.3 Dispatch preflight validation
  - `elixir/lib/symphony_elixir/workflow.ex` — Elixir WORKFLOW.md parsing reference
  - `elixir/lib/symphony_elixir/config.ex` — Elixir config resolution + defaults reference (look at the `defaults/0` function for all default values including Codex sandbox defaults)
  - `elixir/lib/symphony_elixir/workflow_store.ex` — Elixir file watcher reference
  - `yaml` npm package — `parse(str)` returns parsed YAML
  - `chokidar` npm — `watch(path, opts).on('change', cb)`

  **Acceptance Criteria**:
  - [ ] `WorkflowStoreLive` Layer exported from `typescript/src/config/index.ts`
  - [ ] All 7 unit tests pass: `bun test typescript/src/config/`
  - [ ] `$VAR` resolution tested with env mock
  - [ ] Invalid reload does NOT throw — logs error, keeps last-good

  **QA Scenarios**:
  ```
  Scenario: WORKFLOW.md with YAML front matter parses correctly
    Tool: Bash
    Steps:
      1. bun test typescript/src/config/ --reporter=verbose
      2. Assert exit code 0
    Expected Result: All config tests pass
    Evidence: .sisyphus/evidence/t5-config-tests.txt

  Scenario: $VAR resolution works
    Tool: Bash
    Steps:
      1. LINEAR_API_KEY=test-key-abc123 bun test typescript/src/config/ --grep "$VAR"
      2. Assert test passes showing api_key resolved to "test-key-abc123"
    Expected Result: Env var resolved correctly
    Evidence: .sisyphus/evidence/t5-var-resolution.txt
  ```

  **Commit**: NO (groups with Wave 2 commit)

- [ ] T6. Linear Tracker Client

  **What to do**:
  - Create `typescript/src/tracker/linear.ts` — `TrackerClient` Layer for Linear
  - HTTP client: use built-in `fetch` with `Authorization` header = `Bearer ${config.tracker.api_key}`
  - Default endpoint: `https://api.linear.app/graphql`
  - Network timeout: 30000ms (use `AbortController` with timeout)
  - Page size: 50
  - **`fetchCandidateIssues()`** — paginated GraphQL query:
    - Filter: `project: { slugId: { eq: $projectSlug } }`, `state: { name: { in: $activeStates } }`
    - Pagination: `first: 50, after: $cursor`, iterate until `pageInfo.hasNextPage == false`
    - Fields: id, identifier, title, description, priority, state.name, branchName, url, labels.nodes.name, createdAt, updatedAt
    - Also fetch `relations(filter: { type: { eq: "blocks" } })` inverse relations for blockers
    - Normalize per §11.3: labels → lowercase, blocked_by from inverse blocks relations, priority → int only, timestamps → Date
  - **`fetchIssueStatesByIds(ids: string[])`** — batch query by ID list:
    - If ids is empty → return [] immediately without API call
    - Query: `issues(filter: { id: { in: $ids } })` with `[ID!]` type
    - Return minimal Issue objects (id, identifier, state only — enough for reconciliation)
  - **`fetchIssuesByStates(states: string[])`** — used for startup cleanup:
    - If states empty → return [] immediately
    - Filter by state names, return identifier fields
  - Error mapping: `TrackerError` union — `linear_api_request`, `linear_api_status`, `linear_graphql_errors`, `linear_unknown_payload`, `linear_missing_end_cursor`
  - `LinearTrackerClientLive` Layer
  - Unit tests `typescript/src/tracker/linear.test.ts`:
    - Candidate fetch uses active states and project slug (mock fetch)
    - Empty `fetchIssuesByStates([])` returns [] without API call
    - Pagination preserves order across pages (mock two-page response)
    - Blockers normalized from inverse blocks relations
    - Labels normalized to lowercase
    - GraphQL errors response → `linear_graphql_errors` error type

  **Must NOT do**:
  - Do not implement tracker write APIs
  - Do not hard-code the Linear endpoint — use config

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: GraphQL, pagination, normalization, error mapping
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T5, T7)
  - **Parallel Group**: Wave 2
  - **Blocks**: T9
  - **Blocked By**: T1, T2

  **References**:
  - `SPEC.md:1143-1220` — §11 Issue Tracker Integration Contract (full normalization rules)
  - `SPEC.md:1159-1175` — §11.2 Linear-specific query semantics
  - `SPEC.md:1180-1200` — §11.3 Normalization rules (labels lowercase, blockers from inverse blocks)
  - `SPEC.md:1193-1208` — §11.4 Error handling contract
  - `elixir/lib/symphony_elixir/linear/` — Elixir Linear GraphQL query reference (look at the actual GraphQL query strings)
  - `SPEC.md:1971-1980` — §17.3 Test matrix for tracker (use as test checklist)

  **Acceptance Criteria**:
  - [ ] `LinearTrackerClientLive` Layer exported
  - [ ] All 6 unit tests pass: `bun test typescript/src/tracker/`
  - [ ] Empty states → no API call (verified by mock not being called)

  **QA Scenarios**:
  ```
  Scenario: Tracker tests pass with mocked fetch
    Tool: Bash
    Steps:
      1. bun test typescript/src/tracker/ --reporter=verbose
      2. Assert exit code 0
      3. Assert "6 tests passed" in output (or more)
    Expected Result: All tracker tests pass
    Evidence: .sisyphus/evidence/t6-tracker-tests.txt

  Scenario: Empty states returns empty without API call
    Tool: Bash
    Steps:
      1. bun test typescript/src/tracker/ --grep "empty"
      2. Assert test passes
    Expected Result: No fetch call made for empty state list
    Evidence: .sisyphus/evidence/t6-empty-states.txt
  ```

  **Commit**: NO (groups with Wave 2 commit)

- [ ] T7. Workspace Manager

  **What to do**:
  - Create `typescript/src/workspace/index.ts` — `WorkspaceManager` Layer implementation
  - **Workspace key sanitization**: replace `[^A-Za-z0-9._-]` with `_` in issue identifier
  - **Path computation**: `path.join(config.workspace.root, sanitizedKey)` → normalize to absolute
  - **Path containment check** (SPEC.md §9.5 Invariant 2):
    - `path.resolve(workspacePath)` must start with `path.resolve(workspaceRoot) + path.sep`
    - If not → throw `WorkspaceError("path_containment_violation")`
  - **Directory creation**: `fs.mkdir(workspacePath, { recursive: true })` — detect if newly created (`created_now`)
  - **Hook execution** (`typescript/src/workspace/hooks.ts`):
    - Execute via `spawn("bash", ["-lc", script], { cwd: workspacePath, timeout: hookTimeoutMs })`
    - Use `@effect/platform-bun` `Command` API for managed subprocess
    - `after_create`: run only when `created_now=true`, fatal on failure (throw WorkspaceError)
    - `before_run`: run before each attempt, fatal on failure
    - `after_run`: run after attempt (success or failure), log errors but do NOT throw
    - `before_remove`: run before deletion, log errors but do NOT throw
    - Timeout: `hooks.timeout_ms` (default 60000)
    - Log hook start, timeout, failure
  - **Workspace removal** (`removeForIssue`):
    - Run `before_remove` hook (best-effort)
    - `fs.rm(workspacePath, { recursive: true, force: true })`
  - **Safety invariant enforcement** (SPEC.md §9.5):
    - Before any agent launch: assert `cwd === workspacePath` (Invariant 1)
    - Assert workspace is under root (Invariant 2 — checked at creation)
    - Assert workspace key passes sanitization (Invariant 3)
  - `WorkspaceManagerLive` Layer
  - Unit tests `typescript/src/workspace/index.test.ts`:
    - Sanitization: `MT-123` → `MT-123`, `ABC/DEF` → `ABC_DEF`, `FOO BAR` → `FOO_BAR`
    - Path containment: path outside root → WorkspaceError
    - `created_now=true` → after_create hook runs
    - `created_now=false` → after_create hook skipped
    - `after_run` failure → logged, not thrown
    - `before_run` failure → WorkspaceError thrown

  **Must NOT do**:
  - Do not skip path containment check
  - Do not run agent with cwd outside workspace
  - Do not use `exec` for hooks — use `spawn` with explicit argv

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Filesystem ops, subprocess hooks, safety invariants, multiple semantics
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T5, T6)
  - **Parallel Group**: Wave 2
  - **Blocks**: T9
  - **Blocked By**: T1, T2

  **References**:
  - `SPEC.md:793-889` — §9 Workspace Management and Safety (full)
  - `SPEC.md:871-889` — §9.5 Safety Invariants (3 invariants — CRITICAL)
  - `SPEC.md:845-868` — §9.4 Workspace Hooks contract (fatal vs ignored)
  - `elixir/lib/symphony_elixir/workspace.ex` — Elixir workspace implementation reference
  - `SPEC.md:1954-1968` — §17.2 test matrix (use as test checklist)
  - `@effect/platform-bun` `Command` docs — subprocess management in Effect

  **Acceptance Criteria**:
  - [ ] `WorkspaceManagerLive` Layer exported
  - [ ] All 6 unit tests pass: `bun test typescript/src/workspace/`
  - [ ] Path containment check verified working
  - [ ] `after_run` failure does NOT propagate

  **QA Scenarios**:
  ```
  Scenario: Workspace tests pass
    Tool: Bash
    Steps:
      1. bun test typescript/src/workspace/ --reporter=verbose
      2. Assert exit code 0
    Expected Result: All workspace tests pass
    Evidence: .sisyphus/evidence/t7-workspace-tests.txt

  Scenario: Path containment violation throws
    Tool: Bash
    Steps:
      1. bun test typescript/src/workspace/ --grep "containment"
      2. Assert test passes (error thrown for out-of-root path)
    Expected Result: WorkspaceError("path_containment_violation")
    Evidence: .sisyphus/evidence/t7-containment.txt
  ```

  **Commit**: NO (groups with Wave 2 commit after T5+T6+T7)

- [ ] T8. Codex Agent Engine

  **What to do**:
  - Create `typescript/src/engine/codex/index.ts` — `AgentEngine` implementation for Codex app-server
  - **Subprocess launch** (`typescript/src/engine/codex/process.ts`):
    - Use `@effect/platform-bun` `Command` + `CommandExecutor` (v4: import from `effect/unstable/process` or `@effect/platform-bun`)
    - `Command.make("bash", "-lc", codexCommand)` with `cwd: workspacePath`
    - Manage process lifetime inside an Effect `Scope` — process terminates when scope closes
    - Separate stdout/stderr streams; parse JSON only from stdout
    - Stdout line buffering: maintain a partial-line buffer; emit complete JSON lines on `\n`; max line size 10MB
    - Stderr: log as diagnostics only, never parse as protocol
  - **JSON-RPC handshake** (`typescript/src/engine/codex/handshake.ts`):
    - Step 1: Send `initialize` request with `clientInfo: { name: "symphony", version: "1.0" }, capabilities: {}`
    - Step 2: Wait for response (read_timeout_ms — default 5000ms)
    - Step 3: Send `initialized` notification
    - Step 4: Send `thread/start` request with `approvalPolicy`, `sandbox: "workspace-write"`, `cwd: workspacePath`
    - Step 5: Read thread/start result → extract `result.thread.id` → `threadId`
    - Step 6: Send `turn/start` request with `threadId`, `input: [{ type: "text", text: prompt }]`, `cwd`, `title: "${identifier}: ${title}"`, `approvalPolicy`, `sandboxPolicy`
    - Step 7: Read turn/start result → extract `result.turn.id` → `turnId`; emit `session_started`
    - ID sequence: use incrementing integer IDs for requests (1, 2, 3...)
  - **Default sandbox/approval** (match Elixir reference):
    - `approvalPolicy`: `{ reject: { sandbox_approval: true, rules: true, mcp_elicitations: true } }`
    - `thread_sandbox`: `"workspace-write"`
    - `turn_sandbox_policy`: `{ type: "workspaceWrite", workspacePath: "/abs/workspace" }`
    - Override from config if provided
  - **Streaming turn** (`typescript/src/engine/codex/streaming.ts`):
    - Read line-delimited JSON from stdout stream
    - Map each message to `AgentEvent`:
      - `turn/completed` → emit `turn_completed`, return success
      - `turn/failed` → emit `turn_failed`, return failure
      - `turn/cancelled` → emit `turn_cancelled`, return failure
      - `thread/tokenUsage/updated` → emit `token_usage` (prefer absolute thread totals)
      - `item/approval/request`, `item/command/execute/approval`, `item/patch/approval`, `approval-request` → auto-approve: send `{ id, result: { approved: true } }` back on stdin; emit `approval_auto_approved`
      - `item/tool/requestUserInput` or user-input-required → emit error, fail hard
      - `item/tool/call` for unknown dynamic tools → send `{ id, result: { success: false, error: "unsupported_tool_call" } }`; emit `unsupported_tool_call`; continue
      - Rate limit events → emit `rate_limit`
      - Other events → emit `notification` or `other`
    - `turn_timeout_ms`: overall stream timeout (1 hour default) via `Effect.timeout`
    - `read_timeout_ms`: per-line timeout during startup handshake (5s default)
  - **Continuation turns**: after `turn/completed`, if worker decides to continue, send another `turn/start` on same `threadId` (no new subprocess)
  - **`AgentSession` implementation**: wraps subprocess + handshake state; `runTurn()` returns `Stream<AgentEvent>`; `abort()` kills process; `dispose()` closes scope
  - **`CodexAgentEngine.layer`**: `Layer<AgentEngine, never, CodexConfig>` — provides `AgentEngine` service

  **Must NOT do**:
  - Do not parse stderr as protocol messages
  - Do not leave approval requests unanswered (session stalls)
  - Do not use `as any` for the JSON-RPC message types without a comment
  - Do not leak the subprocess if `Scope` closes — it must terminate

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex protocol implementation, subprocess lifecycle, multiple interacting pieces, error semantics matter
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T9 — they share no direct implementation deps)
  - **Parallel Group**: Wave 3
  - **Blocks**: T9 (for full integration), T12, T16
  - **Blocked By**: T1, T2, T3, T5

  **References**:
  - `SPEC.md:890-1126` — §10 Agent Runner Protocol (full section — read all of it)
  - `SPEC.md:922-969` — §10.2 Session Startup Handshake (exact JSON-RPC messages)
  - `SPEC.md:973-1058` — §10.3 Streaming Turn + §10.5 Approval/Tool/UserInput policy
  - `SPEC.md:1107-1126` — §10.6 Timeouts and Error Mapping
  - `elixir/lib/symphony_elixir/codex/app_server.ex` — Elixir Codex protocol implementation (reference for exact message handling)
  - `SYMPHONY_PLAN.md:178-197` — Codex engine description
  - Effect v4 `@effect/platform-bun` Command docs: `https://effect.website/docs/platform/command/`
  - Migration guide forking: `https://raw.githubusercontent.com/Effect-TS/effect-smol/main/migration/forking.md`
  - v4 fork API: `Effect.forkChild()` (not `Effect.fork()`), `Effect.forkDetach()` (not `Effect.forkDaemon()`)

  **Acceptance Criteria**:
  - [ ] `typescript/src/engine/codex/index.ts` exports `CodexAgentEngine.layer`
  - [ ] `AgentSession` interface fully implemented
  - [ ] `bun run typecheck` exits 0

  **QA Scenarios**:
  ```
  Scenario: Codex engine compiles cleanly
    Tool: Bash
    Steps:
      1. cd typescript && bun run typecheck
      2. Assert exit code 0, no errors in engine/codex/
    Expected Result: Clean typecheck
    Evidence: .sisyphus/evidence/t8-typecheck.txt

  Scenario: Unsupported tool call returns failure without stalling
    Tool: Bash (unit test)
    Steps:
      1. bun test typescript/src/engine/codex/ --reporter=verbose
      2. Check test for unsupported tool handling passes
    Expected Result: Unsupported tool → sends failure response, does not hang
    Evidence: .sisyphus/evidence/t8-codex-tests.txt
  ```

  **Commit**: NO (groups with T9)

- [ ] T9. Orchestrator Core

  **What to do**:
  - Create `typescript/src/orchestrator/index.ts` — main orchestrator Effect program
  - **State** (`typescript/src/orchestrator/state.ts`):
    - `OrchestratorState` (from types.ts) held in `Ref.make(initialState)` — single mutable ref, all mutations through Effect
    - Initial state: empty running/claimed/retry maps, zero token totals, poll interval from config
  - **Poll loop** (`typescript/src/orchestrator/poll.ts`):
    - `Effect.repeat(tick, Schedule.spaced(Duration.millis(pollIntervalMs)))`
    - First tick immediate (delay 0), then repeat on interval
    - Poll interval must update dynamically on config reload: check `Ref<WorkflowDefinition>` each tick for current interval
  - **Tick sequence** (SPEC.md §8.1):
    1. Reconcile active runs (stall detection + state refresh)
    2. Validate dispatch config; if invalid → log + skip dispatch, keep reconciliation
    3. Fetch candidate issues from tracker; if fails → log + skip dispatch
    4. Sort by priority (asc, null last), then `created_at` (oldest first), then `identifier` (lexicographic)
    5. For each candidate: if no slots → break; if eligible → dispatch
    6. Notify observers (update observability state)
  - **Candidate eligibility** (SPEC.md §8.2 — ALL must be true):
    - Has id, identifier, title, state
    - State in `active_states`, not in `terminal_states`
    - Not in `running` map
    - Not in `claimed` set
    - Global slots available: `max_concurrent_agents - running.size > 0`
    - Per-state slots available (check `max_concurrent_agents_by_state`)
    - Blocker rule: if state normalized = "todo" → no non-terminal blockers
  - **Dispatch** (`typescript/src/orchestrator/dispatch.ts`):
    - Add to `claimed` set
    - `Effect.forkChild(workerEffect)` — child fiber per issue (v4 API!)
    - Store fiber handle in `running` map entry
    - Worker exits → orchestrator receives result → apply state transition
  - **Worker lifecycle** (`typescript/src/orchestrator/worker.ts`):
    - Create/reuse workspace → run `before_run` hook → create AgentSession → run turns loop
    - Turn loop: build prompt → `session.runTurn()` → stream events → on completion, re-check issue state → if still active and turns < max_turns → next turn
    - First turn: full rendered prompt; continuation turns: continuation guidance only
    - After turns loop: stop session → run `after_run` hook (best-effort) → exit normally
    - On any error: stop session → run `after_run` hook (best-effort) → exit abnormally
    - Forward all `AgentEvent`s to orchestrator state updater
  - **Worker exit handling** (SPEC.md §16.6):
    - Normal exit → `completed.add(id)` + schedule continuation retry (attempt 1, delay 1000ms)
    - Abnormal exit → schedule exponential backoff: `min(10000 * 2^(attempt-1), max_retry_backoff_ms)`
    - Update `codex_totals.seconds_running` on worker exit
  - **Retry handling** (SPEC.md §8.4):
    - `schedule_retry`: cancel existing timer, store `RetryEntry`, set timer with `Effect.sleep` + dispatch
    - On retry timer fires: fetch candidates → find issue → if not found release claim → if no slots requeue → dispatch
  - **Reconciliation** (SPEC.md §8.5 + §16.3):
    - Part A (stall detection): for each running issue, compute elapsed since `last_codex_timestamp` or `started_at`; if `> stall_timeout_ms` (and stall_timeout_ms > 0) → interrupt fiber + schedule retry
    - Part B (state refresh): `fetchIssueStatesByIds(runningIds)` → for each: terminal → kill + cleanup workspace; still active → update snapshot; neither → kill, no cleanup
    - If state refresh fails → keep workers, try next tick
  - **Startup terminal cleanup** (SPEC.md §8.6):
    - `fetchIssuesByStates(terminalStates)` → for each, remove workspace; if fetch fails → log + continue
  - **Token accounting**: on `token_usage` AgentEvent, update running entry's token fields (prefer absolute totals, track deltas to avoid double-counting)
  - **Rate limit tracking**: on `rate_limit` AgentEvent, update `codex_rate_limits` in state
  - `OrchestratorLive` Layer — the main program Effect

  **Must NOT do**:
  - No direct mutation of state outside `Ref.update` / `Ref.modify`
  - No `Effect.fork` (v3 API) — use `Effect.forkChild` (v4)
  - No blocking I/O on the orchestrator fiber — all I/O is Effect-wrapped

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: The most complex component — state machine, concurrency, retry math, reconciliation, multi-fiber coordination
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T8)
  - **Parallel Group**: Wave 3
  - **Blocks**: T10, T11, T15
  - **Blocked By**: T1, T2, T3, T4, T5, T6, T7 (needs all Wave 1+2 types)

  **References**:
  - `SPEC.md:581-791` — §7 Orchestration State Machine + §8 Polling/Scheduling/Reconciliation (full)
  - `SPEC.md:1680-1914` — §16 Reference Algorithms (pseudocode for all flows — FOLLOW EXACTLY)
  - `elixir/lib/symphony_elixir/orchestrator.ex` — Elixir orchestrator reference (most valuable file in the codebase)
  - `SYMPHONY_PLAN.md:199-224` — Effect patterns for orchestrator
  - v4 fork API: `Effect.forkChild()`, `Effect.forkDetach()` — see `https://raw.githubusercontent.com/Effect-TS/effect-smol/main/migration/forking.md`
  - `Effect.Ref` — unchanged in v4: `Ref.make()`, `Ref.update()`, `Ref.modify()`, `Ref.get()`
  - `Schedule.spaced()` — unchanged in v4
  - v4 `Effect.sleep(Duration.millis(n))` for retry timers

  **Acceptance Criteria**:
  - [ ] `typescript/src/orchestrator/index.ts` exports `OrchestratorLive` Layer
  - [ ] `bun run typecheck` exits 0
  - [ ] All state mutations go through `Ref.update` (grep check)

  **QA Scenarios**:
  ```
  Scenario: Orchestrator module typechecks cleanly
    Tool: Bash
    Steps:
      1. cd typescript && bun run typecheck 2>&1 | grep orchestrator
      2. Assert no errors in orchestrator/ files
    Expected Result: Zero type errors
    Evidence: .sisyphus/evidence/t9-typecheck.txt

  Scenario: No direct state mutation (grep for forbidden patterns)
    Tool: Bash
    Steps:
      1. grep -r "state\." typescript/src/orchestrator/ | grep -v "Ref\." | grep -v "//"
      2. Assert no lines of direct mutation outside Ref calls
    Expected Result: All mutations via Ref
    Evidence: .sisyphus/evidence/t9-state-safety.txt
  ```

  **Commit**: YES (after T8+T9 together)
  - Message: `feat(typescript): add codex agent engine and orchestrator state machine`
  - Files: `typescript/src/engine/`, `typescript/src/orchestrator/`

- [ ] T10. Observability + HTTP Server

  **What to do**:
  - Create `typescript/src/observability/logger.ts` — structured Effect Logger setup
    - Use Effect's built-in `Logger` (v4: `import { Logger } from "effect"`)
    - Log level from env `LOG_LEVEL` or default `info`
    - Every issue-related log MUST include `issue_id` and `issue_identifier` as annotations: `Effect.annotateLogs({ issue_id: ..., issue_identifier: ... })`
    - Session logs MUST include `session_id`
    - Format: `key=value` pairs per §13.1
    - Output to stderr (not stdout — stdout reserved for Codex subprocess protocol)
  - Create `typescript/src/observability/snapshot.ts` — runtime snapshot builder
    - `buildSnapshot(state: OrchestratorState): RuntimeSnapshot` — pure function, no effects
    - Returns: `{ generated_at, counts: { running, retrying }, running: RunningRow[], retrying: RetryRow[], codex_totals, rate_limits }`
    - `seconds_running` = `codex_totals.seconds_running` (ended) + sum of elapsed seconds for active sessions
    - Each running row includes `turn_count`, `last_event`, `last_message`, `started_at`, `last_event_at`, `tokens`
  - Create `typescript/src/observability/http.ts` — optional Hono HTTP server
    - `startHttpServer(port: number, stateRef: Ref<OrchestratorState>): Effect<void>`
    - `GET /api/v1/state` → `200 application/json` snapshot
    - `GET /api/v1/:identifier` → `200` issue details or `404 { error: { code: "issue_not_found", message: "..." } }`
    - `POST /api/v1/refresh` → `202 { queued: true, coalesced: false, requested_at: ..., operations: ["poll", "reconcile"] }` — trigger immediate tick (use a `Deferred` or shared queue signal)
    - `GET /` → `200 text/plain "Symphony is running."` (no dashboard HTML in Phase 1)
    - Unsupported methods → `405 Method Not Allowed`
    - Bind to `127.0.0.1` (loopback only per spec §13.7)
    - Start HTTP server only when port is provided
    - Use Hono with Bun adapter: `import { Hono } from "hono"`, serve with `Bun.serve`
  - `ObservabilityLive` Layer — provides logger + optional HTTP server (scoped)

  **Must NOT do**:
  - Do not log to stdout — Effect Logger goes to stderr
  - Do not serve on `0.0.0.0` by default — loopback only
  - Do not make orchestrator correctness depend on HTTP server being up

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Multiple sub-components, API shapes spec'd exactly, structured logging semantics
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T11, T12, T13)
  - **Parallel Group**: Wave 4
  - **Blocks**: T11, T17
  - **Blocked By**: T8, T9

  **References**:
  - `SPEC.md:1255-1521` — §13 Logging, Status, Observability (full — JSON API shapes in §13.7.2)
  - `elixir/lib/symphony_elixir/http_server.ex` — Elixir HTTP server reference
  - `elixir/lib/symphony_elixir/status_dashboard.ex` — Elixir snapshot reference
  - Effect v4 `Logger` docs: `Effect.annotateLogs`, `Logger.withMinimumLogLevel`
  - Hono Bun adapter: `https://hono.dev/docs/getting-started/bun`

  **Acceptance Criteria**:
  - [ ] `ObservabilityLive` Layer exported
  - [ ] `bun run typecheck` exits 0
  - [ ] HTTP server starts on given port (verified by curl)

  **QA Scenarios**:
  ```
  Scenario: HTTP server responds to /api/v1/state
    Tool: Bash
    Steps:
      1. Start a minimal Effect program providing ObservabilityLive with port 3457
      2. curl -s http://127.0.0.1:3457/api/v1/state
      3. Assert response is valid JSON with "running", "retrying", "codex_totals" fields
    Expected Result: 200 JSON with correct shape
    Evidence: .sisyphus/evidence/t10-api-state.txt

  Scenario: Unknown identifier returns 404
    Tool: Bash
    Steps:
      1. curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3457/api/v1/FAKE-999
      2. Assert HTTP status 404
    Expected Result: 404 with JSON error envelope
    Evidence: .sisyphus/evidence/t10-404.txt
  ```

  **Commit**: NO (groups with Wave 4)

- [ ] T11. CLI Entrypoint

  **What to do**:
  - Create `typescript/src/cli/index.ts` — CLI entry point
  - **Argument parsing** (plain `process.argv` — no `@effect/cli`):
    - `symphony [workflow-path] [--port <n>]`
    - Default workflow path: `./WORKFLOW.md`
    - `--port <n>`: enable HTTP server on port n
    - `--help`: print usage and exit 0
    - Unknown args: print usage and exit 1
    - Non-existent explicit workflow path: print error and exit 1
    - Missing default `./WORKFLOW.md`: print error and exit 1
  - Create `typescript/src/main.ts` — Effect Layer composition root:
    ```typescript
    const MainLayer = Layer.mergeAll(
      WorkflowStoreLive,
      LinearTrackerClientLive,
      WorkspaceManagerLive,
      PromptEngineLive,
      CodexAgentEngineLive,  // or OpenCodeAgentEngineLive based on config
      OrchestratorLive,
      ObservabilityLive,
    )
    Effect.runPromise(
      mainProgram.pipe(Effect.provide(MainLayer))
    )
    ```
  - **Graceful shutdown**: listen for `SIGTERM` and `SIGINT`; on signal: interrupt the main Effect fiber cleanly (scopes close, subprocesses terminate)
    - In v4: use `Effect.onInterrupt` to handle cleanup; signal handlers call `fiber.interrupt()`
  - **Startup validation**: before starting poll loop, run dispatch preflight validation; if fails → log error + `process.exit(1)`
  - **Exit codes**: 0 on clean shutdown, 1 on startup failure or abnormal termination
  - Add `symphony` binary entry to `package.json` scripts: `"symphony": "bun run src/cli/index.ts"`
  - Also add: `"build": "bun build src/cli/index.ts --outfile dist/symphony --target bun"`

  **Must NOT do**:
  - No `process.exit()` in library code — only in CLI entrypoint
  - No `@effect/cli` dependency

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small focused file, mostly wiring + arg parsing
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T10, T12, T13)
  - **Parallel Group**: Wave 4
  - **Blocks**: TF1-TF4
  - **Blocked By**: T5, T9, T10

  **References**:
  - `SPEC.md:2041-2048` — §17.7 CLI conformance test requirements
  - `elixir/lib/symphony_elixir/cli.ex` — Elixir CLI reference
  - `SYMPHONY_PLAN.md:238-243` — CLI description
  - Effect v4 fiber keep-alive: `https://raw.githubusercontent.com/Effect-TS/effect-smol/main/migration/fiber-keep-alive.md`

  **Acceptance Criteria**:
  - [ ] `bun run symphony --help` prints usage and exits 0
  - [ ] `bun run symphony ./nonexistent.md` exits nonzero with clear error
  - [ ] `package.json` has `symphony` and `build` scripts

  **QA Scenarios**:
  ```
  Scenario: --help exits cleanly
    Tool: Bash
    Steps:
      1. cd typescript && bun run symphony --help
      2. Assert exit code 0
      3. Assert stdout contains "Usage" or "symphony"
    Expected Result: Usage printed, exit 0
    Evidence: .sisyphus/evidence/t11-help.txt

  Scenario: Nonexistent workflow path exits nonzero
    Tool: Bash
    Steps:
      1. cd typescript && bun run symphony ./does-not-exist.md 2>&1; echo "EXIT:$?"
      2. Assert output contains "EXIT:1"
    Expected Result: Error message printed, exit 1
    Evidence: .sisyphus/evidence/t11-missing-workflow.txt
  ```

  **Commit**: YES (after Wave 4: T10+T11+T12+T13)
  - Message: `feat(typescript): add observability, CLI, opencode engine, agent abstraction`

- [ ] T12. AgentEngine Abstraction Hardening (Phase 2)

  **What to do**:
  - Review `typescript/src/engine/agent.ts` after T8 implementation — ensure no Codex-specific types leaked into the interface
  - `AgentEvent` union: ensure every event type the orchestrator uses is in the abstract union (no Codex-only types)
  - `AgentEngineError` and `AgentSessionError`: review and document exactly what each signals
  - Add `agent.engine` config field to `WorkflowConfig.agent`: `engine?: "codex" | "opencode"` (default: `"codex"`)
  - Document the `AgentSession` contract in a comment block in `agent.ts`:
    - What `runTurn` must emit before returning
    - What `abort()` guarantees (subprocess terminated)
    - What `dispose()` guarantees (all resources released)
    - Continuation turn semantics (same threadId, no new subprocess)
  - In `typescript/src/main.ts`: read `agent.engine` from resolved config → provide `CodexAgentEngineLive` or `OpenCodeAgentEngineLive` Layer at composition time
  - Write `typescript/src/engine/agent.test.ts`: contract tests verifiable against any engine implementation (mock engine that satisfies the interface)

  **Must NOT do**:
  - Do not add Codex-specific fields to `AgentEvent`
  - Do not break the `AgentSession` interface signature

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Interface design + documentation + config extension + wiring
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T10, T11, T13)
  - **Parallel Group**: Wave 4
  - **Blocks**: T13
  - **Blocked By**: T1, T2, T3, T8

  **References**:
  - `SYMPHONY_PLAN.md:54-109` — AgentEngine service definition and abstraction
  - `SYMPHONY_PLAN.md:245-283` — Phase 2 formalization
  - `SPEC.md:887-1126` — §10 Agent Runner Protocol (what the interface must cover)

  **Acceptance Criteria**:
  - [ ] `agent.engine` config field in `WorkflowConfig`
  - [ ] `typescript/src/engine/agent.ts` has documented contract comment
  - [ ] `bun run typecheck` exits 0
  - [ ] Contract test file exists

  **QA Scenarios**:
  ```
  Scenario: Engine abstraction compiles with no leaks
    Tool: Bash
    Steps:
      1. cd typescript && bun run typecheck 2>&1 | grep engine/agent
      2. Assert no type errors in engine/agent.ts
    Expected Result: Clean typecheck
    Evidence: .sisyphus/evidence/t12-typecheck.txt
  ```

  **Commit**: NO (groups with Wave 4)

- [ ] T13. OpenCode Agent Engine (Phase 3)

  **What to do**:
  - Create `typescript/src/engine/opencode/index.ts` — `AgentEngine` implementation for OpenCode
  - **Per-workspace server mode** (recommended, implement first):
    - Spawn `opencode serve --port 0` subprocess per workspace using `@effect/platform-bun` Command
    - Parse the ephemeral port from stdout (look for port announcement line)
    - Create HTTP client pointing to `http://localhost:{port}`
    - Kill subprocess when `Scope` closes
  - **Shared server mode** (secondary):
    - Connect to pre-existing OpenCode server at `config.opencode.server_url`
    - Pass `x-opencode-directory: workspacePath` header on all requests
  - **Session lifecycle** (using `@opencode-ai/sdk` or raw fetch):
    - Create: `POST /session` with title, directory header
    - Send prompt: `POST /session/:id/message` with `{ parts: [{ type: "text", text: prompt }], agent, model }`
    - Continuation: another `POST /session/:id/message` on same session
    - Abort: `POST /session/:id/abort`
  - **SSE event streaming** (`GET /event`):
    - Subscribe to SSE stream
    - Filter events by `sessionID`
    - Map OpenCode events → `AgentEvent`:
      - `session.status { type: "idle" }` → `turn_completed`
      - `session.error` → `turn_failed`
      - `permission.asked` → auto-approve via `POST /permission/:id { reply: "approve" }` + emit `approval_auto_approved`
      - `message.part.updated` → `notification`
      - `server.heartbeat` → `stall_heartbeat` (used for stall detection liveness)
      - Other → `other`
  - **Token accounting**: extract from session/message metadata or SSE events
  - **`OpenCodeAgentEngine.layer`**: `Layer<AgentEngine, never, OpenCodeConfig>`
  - Config from `WorkflowConfig.opencode`: `mode`, `server_url`, `model`, `agent`, `port`
  - Install `@opencode-ai/sdk@latest` or use raw `fetch` if SDK not available

  **Must NOT do**:
  - Do not mix per-workspace and shared mode in the same code path
  - Do not leave SSE connections open after session ends

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: HTTP client, SSE streaming, subprocess spawning, two modes, permission bridge
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T10, T11)
  - **Parallel Group**: Wave 4
  - **Blocks**: T18
  - **Blocked By**: T1, T2, T3, T12

  **References**:
  - `SYMPHONY_PLAN.md:289-367` — Phase 3 OpenCode engine spec (full section)
  - `SYMPHONY_PLAN.md:343-368` — OpenCode SDK usage example
  - `SPEC.md:889` — AgentEngine interface contract
  - OpenCode API: per SYMPHONY_PLAN.md §3.1, use `POST /session`, `POST /session/:id/message`, `GET /event`, `POST /permission/:id`
  - `@opencode-ai/sdk` — try `import { createOpencodeClient } from "@opencode-ai/sdk/v2"` first

  **Acceptance Criteria**:
  - [ ] `OpenCodeAgentEngine.layer` exported
  - [ ] Per-workspace mode: spawns `opencode serve`, parses port, creates session
  - [ ] `bun run typecheck` exits 0

  **QA Scenarios**:
  ```
  Scenario: OpenCode engine typechecks
    Tool: Bash
    Steps:
      1. cd typescript && bun run typecheck 2>&1 | grep engine/opencode
      2. Assert no errors
    Expected Result: Clean typecheck
    Evidence: .sisyphus/evidence/t13-typecheck.txt
  ```

  **Commit**: NO (groups with Wave 4)

- [ ] T14. Config + Workspace + Tracker Tests (§17.1 + §17.2 + §17.3)

  **What to do**:
  - Add/expand tests in `typescript/src/config/`, `typescript/src/workspace/`, `typescript/src/tracker/`
  - Cover ALL bullets in SPEC.md §17.1 (Workflow and Config Parsing):
    - Explicit workflow path used when provided (vs cwd default)
    - File change detected → re-read/re-apply (test with temp file + chokidar)
    - Invalid reload keeps last-known-good
    - Missing WORKFLOW.md → typed error `missing_workflow_file`
    - Invalid YAML → typed error `workflow_parse_error`
    - Front matter non-map → `workflow_front_matter_not_a_map`
    - All config defaults apply when optional values missing
    - `tracker.kind` validation
    - `$VAR` resolution (tracker api key + path values)
    - `~` expansion
    - `codex.command` preserved as shell string (no $VAR expansion)
    - `max_concurrent_agents_by_state` normalizes keys, ignores invalid values
    - Prompt renders `issue` and `attempt`
    - Unknown template variables fail rendering
  - Cover ALL bullets in SPEC.md §17.2 (Workspace Manager and Safety):
    - Deterministic workspace path per identifier
    - Missing dir created, existing dir reused
    - `after_create` hook runs only on new creation
    - `before_run` failure aborts attempt
    - `after_run` failure is logged and ignored
    - Path sanitization and root containment enforced
  - Cover ALL bullets in SPEC.md §17.3 (Issue Tracker Client):
    - Candidate fetch uses active states and project slug
    - Empty `fetchIssuesByStates([])` returns [] without API call
    - Pagination preserves order across pages
    - Blockers normalized from inverse blocks relations
    - Labels normalized to lowercase
    - Error mapping for each error category

  **Must NOT do**:
  - Do not write tests that require real Linear credentials (mock everything)
  - Do not write integration tests that touch the filesystem unless using tmp dirs (cleanup after)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Large test coverage effort, careful spec-to-test mapping
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T15, T16, T17, T18)
  - **Parallel Group**: Wave 5
  - **Blocks**: TF2
  - **Blocked By**: T5, T6, T7

  **References**:
  - `SPEC.md:1933-1980` — §17.1, §17.2, §17.3 (exact test bullet list — implement one test per bullet)
  - `@effect/vitest@4.0.0-beta.27` for Effect-aware test helpers if needed
  - Use `vitest` `vi.mock()` for fetch mocking, temp dirs for filesystem tests

  **Acceptance Criteria**:
  - [ ] `bun test typescript/src/config/ typescript/src/workspace/ typescript/src/tracker/` all pass
  - [ ] Every §17.1, §17.2, §17.3 bullet has a corresponding test

  **QA Scenarios**:
  ```
  Scenario: Config/workspace/tracker tests all pass
    Tool: Bash
    Steps:
      1. cd typescript && bun test src/config/ src/workspace/ src/tracker/ --reporter=verbose
      2. Assert exit code 0
      3. Count passing tests — assert >= 25
    Expected Result: All tests pass, high coverage of spec bullets
    Evidence: .sisyphus/evidence/t14-tests.txt
  ```

  **Commit**: NO (groups with Wave 5)

- [ ] T15. Orchestrator + Retry + Reconciliation Tests (§17.4)

  **What to do**:
  - Create `typescript/src/orchestrator/orchestrator.test.ts`
  - Cover ALL bullets in SPEC.md §17.4 (Orchestrator Dispatch, Reconciliation, and Retry):
    - Dispatch sort order: priority asc → oldest created_at → identifier
    - `Todo` issue with non-terminal blockers → NOT dispatched
    - `Todo` issue with terminal-only blockers → IS dispatched
    - Active-state refresh → updates running entry state
    - Non-active state → stops agent, NO workspace cleanup
    - Terminal state → stops agent + cleans workspace
    - Reconciliation with no running issues → no-op
    - Normal worker exit → schedules continuation retry (attempt 1)
    - Abnormal worker exit → exponential backoff: `10000 * 2^(attempt-1)` capped at `max_retry_backoff_ms`
    - Retry backoff cap respected
    - Retry queue entries have attempt, due time, identifier, error
    - Stall detection kills stalled sessions + schedules retry
    - Slot exhaustion → requeues with error `"no available orchestrator slots"`
    - Snapshot API returns running rows, retry rows, token totals, rate limits
  - Use mock `AgentEngine`, mock `TrackerClient`, mock `WorkspaceManager` — no real subprocesses
  - Test state machine transitions by observing `Ref<OrchestratorState>` after events

  **Must NOT do**:
  - Do not spawn real Codex subprocesses in unit tests
  - Do not use real Linear API

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Complex state machine testing, careful mock setup, many edge cases
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T14, T16, T17, T18)
  - **Parallel Group**: Wave 5
  - **Blocks**: TF2
  - **Blocked By**: T9

  **References**:
  - `SPEC.md:1982-1999` — §17.4 exact bullet list
  - `SPEC.md:737-743` — §8.4 backoff formula: `min(10000 * 2^(attempt-1), max_retry_backoff_ms)`
  - `elixir/test/` — Elixir test suite as reference for test scenarios

  **Acceptance Criteria**:
  - [ ] `bun test typescript/src/orchestrator/` passes
  - [ ] Every §17.4 bullet has a corresponding test

  **QA Scenarios**:
  ```
  Scenario: Orchestrator tests pass
    Tool: Bash
    Steps:
      1. cd typescript && bun test src/orchestrator/ --reporter=verbose
      2. Assert exit code 0, >= 15 tests passing
    Expected Result: All orchestrator tests pass
    Evidence: .sisyphus/evidence/t15-orchestrator-tests.txt
  ```

  **Commit**: NO (groups with Wave 5)

- [ ] T16. Codex Engine Tests (§17.5)

  **What to do**:
  - Create `typescript/src/engine/codex/codex.test.ts`
  - Use a mock subprocess that writes controlled JSON to stdout
  - Cover ALL bullets in SPEC.md §17.5 (Coding-Agent App-Server Client):
    - Launch command uses workspace cwd + `bash -lc <codex.command>`
    - Startup handshake sends `initialize`, `initialized`, `thread/start`, `turn/start`
    - `initialize` includes clientInfo/capabilities
    - Policy-related startup payloads use documented defaults
    - `thread/start` + `turn/start` parse nested IDs, emit `session_started`
    - `read_timeout_ms` enforced during startup
    - `turn_timeout_ms` enforced
    - Partial JSON lines buffered until newline
    - Stdout and stderr handled separately (stderr does not crash parsing)
    - Non-JSON stderr logged but does not crash
    - Approval requests (all 4 method variants) handled → auto-approved
    - Unsupported dynamic tool calls rejected without stalling
    - User input requests hard-fail
    - Token/rate-limit payloads extracted from nested shapes

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Protocol testing, mock subprocess, careful message sequencing
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T14, T15, T17, T18)
  - **Parallel Group**: Wave 5
  - **Blocks**: TF2
  - **Blocked By**: T8

  **References**:
  - `SPEC.md:2001-2028` — §17.5 exact bullet list
  - `elixir/test/` — Elixir Codex test reference

  **Acceptance Criteria**:
  - [ ] `bun test typescript/src/engine/codex/` passes
  - [ ] Every §17.5 bullet covered

  **QA Scenarios**:
  ```
  Scenario: Codex engine tests pass
    Tool: Bash
    Steps:
      1. cd typescript && bun test src/engine/codex/ --reporter=verbose
      2. Assert exit code 0
    Expected Result: All codex protocol tests pass
    Evidence: .sisyphus/evidence/t16-codex-tests.txt
  ```

  **Commit**: NO (groups with Wave 5)

- [ ] T17. Observability + CLI Tests (§17.6 + §17.7)

  **What to do**:
  - Create `typescript/src/observability/observability.test.ts`:
    - Validation failures are logged (observable via Logger output)
    - Structured logging includes issue/session context fields
    - Token/rate-limit aggregation correct across repeated updates
    - HTTP server responds with correct JSON shapes (use Hono test client or fetch against started server)
    - HTTP `/api/v1/state` returns correct snapshot fields
    - HTTP `POST /api/v1/refresh` returns 202
    - Unknown identifier returns 404
  - Create `typescript/src/cli/cli.test.ts`:
    - CLI accepts optional positional workflow path argument
    - CLI uses `./WORKFLOW.md` when no path provided
    - CLI errors on nonexistent explicit path
    - CLI exits 0 on normal shutdown
    - CLI exits nonzero on startup failure

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: HTTP server testing, CLI subprocess testing, structured log assertion
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T14, T15, T16, T18)
  - **Parallel Group**: Wave 5
  - **Blocks**: TF2
  - **Blocked By**: T10, T11

  **References**:
  - `SPEC.md:2030-2048` — §17.6 and §17.7 exact bullet lists

  **Acceptance Criteria**:
  - [ ] `bun test typescript/src/observability/ typescript/src/cli/` passes
  - [ ] All §17.6 + §17.7 bullets covered

  **QA Scenarios**:
  ```
  Scenario: Observability and CLI tests pass
    Tool: Bash
    Steps:
      1. cd typescript && bun test src/observability/ src/cli/ --reporter=verbose
      2. Assert exit code 0
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/t17-obs-cli-tests.txt
  ```

  **Commit**: YES (after Wave 5: T14–T18)
  - Message: `test(typescript): add vitest conformance test suite (spec §17)`

- [ ] T18. OpenCode Engine Tests (Extension Conformance)

  **What to do**:
  - Create `typescript/src/engine/opencode/opencode.test.ts`
  - Use a mock HTTP server (e.g. MSW or inline Bun server) to simulate OpenCode API
  - Cover per §17 extension conformance:
    - Session create/prompt/abort lifecycle (POST /session, /message, /abort)
    - SSE event mapping: `session.status{idle}` → `turn_completed`; `session.error` → `turn_failed`
    - Permission auto-handling: `permission.asked` → auto-approve via POST /permission/:id
    - `server.heartbeat` → `stall_heartbeat` event emitted
    - Per-workspace server spawn: spawns `opencode serve --port 0`, parses port from stdout
    - Shared server mode: uses `x-opencode-directory` header

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: SSE testing, mock HTTP server, subprocess spawn simulation
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T14, T15, T16, T17)
  - **Parallel Group**: Wave 5
  - **Blocks**: TF2
  - **Blocked By**: T13

  **References**:
  - `SYMPHONY_PLAN.md:289-367` — OpenCode engine spec
  - `SPEC.md:2030` — extension conformance profile

  **Acceptance Criteria**:
  - [ ] `bun test typescript/src/engine/opencode/` passes

  **QA Scenarios**:
  ```
  Scenario: OpenCode engine tests pass
    Tool: Bash
    Steps:
      1. cd typescript && bun test src/engine/opencode/ --reporter=verbose
      2. Assert exit code 0
    Expected Result: All OpenCode tests pass
    Evidence: .sisyphus/evidence/t18-opencode-tests.txt
  ```

  **Commit**: NO (groups with Wave 5)

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE.

> 4 review agents run in PARALLEL. ALL must APPROVE.

> 4 review agents run in PARALLEL. ALL must APPROVE.

> 4 review agents run in PARALLEL. ALL must APPROVE.

- [ ] TF1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check evidence files exist.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] TF2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` (or `bun run typecheck`) + `bun test`. Review changed files for `as any`/`@ts-ignore`, `console.log`, commented-out code, unused imports. Check for AI slop patterns.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] TF3. **Real QA** — `unspecified-high`
  From clean state in `typescript/`: `bun run symphony ../elixir/WORKFLOW.md --port 3456` (using Elixir WORKFLOW.md as fixture, with fake LINEAR_API_KEY). Verify: process starts, logs appear, HTTP server answers at port 3456, `/api/v1/state` returns valid JSON, SIGTERM causes clean shutdown. Save terminal output as evidence.
  Output: `Startup [PASS/FAIL] | HTTP [PASS/FAIL] | Shutdown [PASS/FAIL] | VERDICT`

- [ ] TF4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual files created. Verify 1:1 — everything specified was built, nothing beyond spec was added. Flag unaccounted files/changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- After T1: `chore(typescript): initialize bun+typescript+effect project scaffold`
- After Wave 2: `feat(typescript): add config layer, linear client, workspace manager`
- After T8: `feat(typescript): add codex agent engine with effect subprocess management`
- After T9: `feat(typescript): add orchestrator state machine with poll loop and retry`
- After Wave 4: `feat(typescript): add observability, CLI, opencode engine, agent abstraction`
- After Wave 5: `test(typescript): add vitest conformance test suite (spec §17)`

## Success Criteria

### Verification Commands
```bash
# From typescript/ directory:
bun test                          # Expected: all tests pass
bun run typecheck                 # Expected: no type errors
bun run symphony --help           # Expected: usage printed
LINEAR_API_KEY=fake bun run symphony ../elixir/WORKFLOW.md --port 3456
# Expected: starts, logs "validation error: missing/invalid api_key" or connects
curl localhost:3456/api/v1/state  # Expected: JSON with running/retrying/codex_totals
```

### Final Checklist
- [ ] All §18.1 Required for Conformance items implemented
- [ ] `bun test` passes
- [ ] `bun run build` or `bun run symphony` works from `typescript/`
- [ ] No TypeScript errors
- [ ] Structured logs include `issue_id`, `issue_identifier`, `session_id`
- [ ] HTTP server responds at configured port
- [ ] Graceful shutdown on SIGTERM
