# Learnings — symphony-typescript

## Session ses_33f9c233fffeRkBJvbiSbCg9up — 2026-03-06

### Effect v4 Beta Critical Facts
- Version: `effect@4.0.0-beta.27`, `@effect/platform-bun@4.0.0-beta.27` (unified versioning)
- `@effect/platform` is INSIDE `effect` in v4 — do NOT install separately
- Service definition: `ServiceMap.Service<Self, Shape>()(id)` NOT `Context.Tag`
- Fork: `Effect.forkChild()` (was `Effect.fork()`), `Effect.forkDetach()` (was `Effect.forkDaemon()`)
- Layer naming: `.layer` not `.Default`
- No static proxy accessors — use `yield*` in generators or `.use()`
- Platform APIs: `effect/unstable/http`, `effect/unstable/process` (unstable modules)
- `@effect/vitest@4.0.0-beta.27` for test helpers

### Codebase State
- Pure greenfield TypeScript — nothing exists yet
- Elixir reference at `elixir/lib/symphony_elixir/` — use for algorithmic reference
- Working in `typescript/` directory at repo root
- Branch: `typescript-impl`

### Key References
- SPEC.md §16 has pseudocode for ALL major algorithms — follow exactly
- `elixir/lib/symphony_elixir/orchestrator.ex` — most valuable reference file
- MIGRATION.md: https://raw.githubusercontent.com/Effect-TS/effect-smol/main/MIGRATION.md

## T2: Shared Types + Domain Model — COMPLETED

### Implementation Notes
- **File**: `typescript/src/types.ts` (370 lines, 37 exports)
- **Approach**: Pure TypeScript types, no Effect imports — types are domain-agnostic
- **Immutability**: All properties `readonly`, using `ReadonlyArray` and `ReadonlyMap` for collections
- **Circular Deps**: `worker_fiber` and `timer_handle` typed as `unknown` to avoid circular dependencies; cast at use site
- **Error Handling**: Discriminated union types with `_tag` field for type-safe error handling
- **Type Safety**: No `any` used; `unknown` for truly untyped values (e.g., approval_policy, rate_limits)

### Domain Sections
1. **Issue** (2 types): `BlockerRef`, `Issue`
2. **Workflow Config** (10 types): `TrackerConfig`, `PollingConfig`, `WorkspaceConfig`, `HooksConfig`, `AgentConfig`, `CodexConfig`, `OpenCodeConfig`, `ServerConfig`, `WorkflowConfig`, `WorkflowDefinition`
3. **Resolved Config** (1 type): `ResolvedConfig` — fully resolved with defaults applied
4. **Workspace** (1 type): `Workspace`
5. **Run Attempt** (1 type): `RunAttemptStatus` (union of 11 status strings)
6. **Agent Events** (2 types): `TokenUsage`, `AgentEvent` (discriminated union of 9 event types)
7. **Orchestrator State** (4 types): `TokenTotals`, `RunningEntry`, `RetryEntry`, `OrchestratorState`
8. **Errors** (12 types): 6 error code unions + 6 error interfaces + 1 error union
9. **HTTP API Shapes** (3 types): `RunningRow`, `RetryRow`, `RuntimeSnapshot`

### Verification
- ✓ `tsc --noEmit` exits 0 (no TypeScript errors)
- ✓ 37 exports (requirement: >= 15)
- ✓ Evidence saved to `.sisyphus/evidence/t2-typecheck.txt`
- ✓ All SPEC.md §4 domain types included

## T3: Effect Service Definitions — COMPLETED

### Implementation Notes
- **Files**: 
  - `typescript/src/engine/agent.ts` (AgentEngine service + error/session types)
  - `typescript/src/services.ts` (5 service tags)
- **API**: Effect v4 beta `ServiceMap.Service<Self, Shape>()(id)` pattern
- **Service Count**: 6 total (1 in engine/, 5 in services/)

### Service Definitions

1. **AgentEngine** (`typescript/src/engine/agent.ts`)
   - Class extends `ServiceMap.Service<AgentEngine, Shape>()(id)`
   - Method: `createSession(input): Effect<AgentSession, AgentEngineError>`
   - Supporting types: `AgentEngineError`, `AgentSessionError`, `AgentSession`
   - AgentSession has: `sessionId`, `threadId`, `runTurn()`, `abort()`, `dispose()`

2. **WorkflowStore** (`typescript/src/services.ts`)
   - `get(): Effect<WorkflowDefinition, WorkflowError>`
   - `getResolved(): Effect<ResolvedConfig, ConfigError>`

3. **TrackerClient** (`typescript/src/services.ts`)
   - `fetchCandidateIssues(): Effect<ReadonlyArray<Issue>, TrackerError>`
   - `fetchIssueStatesByIds(ids): Effect<ReadonlyArray<Issue>, TrackerError>`
   - `fetchIssuesByStates(states): Effect<ReadonlyArray<Issue>, TrackerError>`

4. **WorkspaceManager** (`typescript/src/services.ts`)
   - `createForIssue(identifier): Effect<Workspace, WorkspaceError>`
   - `removeForIssue(identifier): Effect<void, WorkspaceError>`
   - `runHook(hook, workspacePath): Effect<void, never>`

5. **PromptEngine** (`typescript/src/services.ts`)
   - `render(template, issue, attempt): Effect<string, PromptError>`

6. **OrchestratorStateRef** (`typescript/src/services.ts`)
   - Holds: `ref: Ref<OrchestratorState>`
   - Uses `Ref` from effect (unchanged in v4)

### API Verification
- ✓ ServiceMap.Service exists in effect@4.0.0-beta.27
- ✓ Class extension pattern: `class X extends ServiceMap.Service<X, Shape>()("id") {}`
- ✓ All imports use `.js` extension (NodeNext module resolution)
- ✓ All types imported from `../types.js`
- ✓ No v3 API usage (Context.Tag, Effect.Tag, Effect.Service)
- ✓ No implementation logic (definitions only)

### Verification
- ✓ `tsc --noEmit` exits 0 (no TypeScript errors)
- ✓ Evidence saved to `.sisyphus/evidence/t3-typecheck.txt`
- ✓ All 6 services properly typed with Effect v4 API

## T4: Prompt Engine — COMPLETED

### Implementation Notes
- **Files**:
  - `typescript/src/prompt/index.ts` (PromptEngineLive Layer + render function)
  - `typescript/src/prompt/index.test.ts` (8 comprehensive tests)
- **Library**: `liquidjs@10.0.0` with `strictVariables: true, strictFilters: true`
- **Error Handling**: Strict mode throws on unknown variables (not silent empty strings)
- **Fallback**: Empty/whitespace-only templates return fallback prompt

### Key Implementation Details

1. **Liquid Configuration**
   - `strictVariables: true` — throws on undefined variables (required for T4)
   - `strictFilters: true` — throws on undefined filters
   - Errors caught and converted to PromptError with code discrimination

2. **Context Transformation**
   - Issue converted to plain object (ReadonlyArray → Array, Dates → ISO strings)
   - blocked_by mapped to minimal shape: `{ id, identifier, state }`
   - attempt passed as-is (null or number)

3. **Error Categorization**
   - "parse", "syntax", "unexpected" → `template_parse_error`
   - All others → `template_render_error`
   - Cause preserved for debugging

4. **Layer Pattern**
   - `Layer.succeed(PromptEngine, { render })` — v4 service provision
   - Tests use `Effect.gen()` with `yield* PromptEngine` to access service
   - `Effect.provide(effect, PromptEngineLive)` to inject layer

### Test Coverage (8 tests)
1. ✓ Renders issue.identifier correctly
2. ✓ Renders attempt as null on first run
3. ✓ Renders attempt as number on retry
4. ✓ Returns fallback for empty template
5. ✓ Returns fallback for whitespace-only template
6. ✓ Throws PromptError for unknown variable (strict mode)
7. ✓ Renders labels array with for loop
8. ✓ Renders multiple fields in complex template

### Verification
- ✓ `npm test -- src/prompt/` exits 0 (8/8 tests pass)
- ✓ `tsc --noEmit` exits 0 (no TypeScript errors)
- ✓ Evidence saved to `.sisyphus/evidence/t4-prompt-tests.txt`
- ✓ Unknown variables throw (not silent) — strict mode working

## T6: Linear Tracker Client — COMPLETED

### Implementation Notes
- **Files**:
  - `typescript/src/tracker/linear.ts` (GraphQL client, normalization, HTTP layer)
  - `typescript/src/tracker/index.ts` (re-exports + `makeLinearTrackerClientLive`)
  - `typescript/src/tracker/index.test.ts` (7 tests)
- **HTTP**: Native `fetch` only, no GraphQL client library
- **Pagination**: Cursor-based while loop for `fetchCandidateIssues` and `fetchIssuesByStates`
- **Short-circuit**: Empty ids/states → `Effect.succeed([])` without hitting network

### Key Implementation Details

1. **Error Flow**
   - `graphqlRequest` throws plain TrackerError-shaped objects (not `Effect.fail`)
   - `Effect.tryPromise` catch handler re-throws pre-tagged errors, wraps unknown errors
   - Check: `if (error !== null && typeof error === "object" && "_tag" in error)` to detect pre-tagged errors

2. **Normalization**
   - Full issues: `normalizeIssue` — includes labels (lowercased), blockers, all fields
   - Minimal issues (state refresh): `normalizeMinimalIssue` — id, identifier, state only
   - Labels: `l.name.toLowerCase()` per spec

3. **Layer Pattern**
   - `makeLinearTrackerClientLive(config)` returns `Layer.Layer<TrackerClient>`
   - Uses `Layer.succeed(TrackerClient, { ...impl })` with closures capturing endpoint/apiKey
   - Not a static `Live` — factory function from `ResolvedConfig`

4. **Test Strategy**
   - `vi.stubGlobal("fetch", mockFn)` + `vi.unstubAllGlobals()` in afterEach
   - Multi-page test: `vi.fn().mockResolvedValueOnce(...).mockResolvedValueOnce(...)`
   - Error tests: `Effect.runPromise(Effect.flip(effect))` to get the error
   - Array index type safety: use `result[0]!` or `const item = result[0]!`

### Test Coverage (7 tests)
1. ✓ Single page → normalized issues, labels lowercased
2. ✓ Two-page pagination → all issues in order, fetch called twice
3. ✓ Blockers normalized from `relations.nodes[].relatedIssue`
4. ✓ `fetchIssueStatesByIds` empty → [] without fetch call
5. ✓ `fetchIssuesByStates` empty → [] without fetch call
6. ✓ GraphQL errors → `linear_graphql_errors` TrackerError
7. ✓ HTTP 401 → `linear_api_status` TrackerError

### Gotcha: bun test vs bun run test
- `bun test` = bun's native runner (no vi.stubGlobal)
- `bun run test` = vitest via package.json script (has vi.stubGlobal)
- Project uses vitest; use `bun run test src/tracker/` for tests
- Pre-existing workspace errors in src/workspace/ (from T5) — not T6 regressions

### Verification
- ✓ `bun run test src/tracker/` exits 0 (7/7 tests pass)
- ✓ LSP diagnostics: 0 errors in all three tracker files
- ✓ Evidence saved to `.sisyphus/evidence/t6-tracker-tests.txt`

## T7: Workspace Manager — COMPLETED

### Effect v4 API Changes (Critical)
- `Effect.async<A, E>((resume) => {...})` → **`Effect.callback<A, E>((resume) => {...})`**
- `Effect.either(effect)` → **`Effect.result(effect)`** (returns `Result` type, not `Either`)
- `Effect.orElse(effect, () => fallback)` → **`Effect.catchCause(effect, () => fallback)`**
- `Result.isFailure(r)` → `r.failure` for error value
- `Result.isSuccess(r)` → `r.value` for success value
- `Effect.ignore(effect)` — swallows all errors (typed as `never` on error channel)

### mkdir({recursive:true}) Detection Pattern
- Node.js `mkdir` with `{recursive: true}` returns `string | undefined`
- Returns the path string when directory is newly created
- Returns `undefined` when directory already existed
- Use `result !== undefined` to detect `created_now`

### Path Safety Implementation
- `resolve(path)` normalizes symlinks/relative refs before containment check
- Check: `resolvedWs.startsWith(resolvedRoot + sep)` — **must include sep** to avoid prefix attacks (e.g., `/root-extra` matching `/root`)
- Also allow exact match `resolvedWs === resolvedRoot` for root itself

### Test Pattern for Best-Effort Effects
- Use `Effect.result(effect)` to inspect failures without throwing
- `Result.isFailure(result)` → `result.failure` for typed error access
- `Effect.catchCause` for best-effort (ignores all failures)
- `Effect.ignore` for fully silent best-effort (no side effects)

### Files Created
- `typescript/src/workspace/hooks.ts` — `runHookScript()` via `spawn("bash", ["-lc", script])`
- `typescript/src/workspace/index.ts` — `sanitizeWorkspaceKey`, `workspacePath`, `assertPathContainment`, `makeWorkspaceManagerLive`
- `typescript/src/workspace/index.test.ts` — 11 tests, all passing

### Test Results
- 11 tests pass, 0 fail
- Zero LSP errors on workspace files
- Pre-existing `src/config/index.ts` errors from another task (Layer.scoped, WorkflowStore.make) — not related to workspace

## T5: Configuration Layer (2026-03-05)

### Effect v4 API Changes (critical, tested in beta.27)
- `Layer.scoped(tag, effect)` → `Layer.effect(tag)(effect)` (curried)
- `Layer.succeed(tag, impl)` still works (non-curried overload at line 708 of Layer.d.ts)
- `ServiceMap.Service` subclass does NOT have a `.make` static method — pass impl object directly
- `Effect.addFinalizer(fn)` takes `(exit: Exit) => Effect<void>` — ignoring `exit` param is fine
- `Layer.effect` automatically excludes `Scope` from requirements (`Exclude<R, Scope.Scope>`)

### WorkflowStore construction pattern
```typescript
Layer.effect(WorkflowStore)(
  Effect.gen(function* () {
    // ... setup ...
    yield* Effect.addFinalizer(() => Effect.sync(() => cleanup()))
    return { get: () => ..., getResolved: () => ... }  // plain object, no .make()
  })
)
```

### Error handling in Layer constructors
- Use `Effect.orDie(loadWorkflowFile(path))` to convert `WorkflowError` to defect
- This keeps `Layer.Layer<WorkflowStore>` (no error channel) — matches codebase pattern
- Appropriate because startup failure is fatal; file-change failures use last-known-good

### resolveConfig with exactOptionalPropertyTypes
- Explicit type annotations needed: `const t: TrackerConfig = config.tracker ?? {}`
- All fields in TrackerConfig/etc are optional, so `{}` is assignable
- `parseStates` accepts `ReadonlyArray<string> | string | undefined` for runtime flexibility

### Testing patterns
- `Effect.flip(effect)` to test failure cases — swaps error/success channels
- `expect(caught).toMatchObject({ _tag: "WorkflowError", code: "..." })` for thrown errors
- Restore env vars in finally blocks when testing `$VAR` resolution
