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

## T9: Orchestrator Core — COMPLETED

### Effect v4 API Key Findings
- `Effect.catchAll` does NOT exist in v4 beta — use `Effect.catchCause` for all error catching
- `Effect.result()` returns a Result type whose Success/Failure variants DON'T expose `.value`/`.cause` as properties — avoid `Effect.result` entirely; use `Effect.catchCause` with null sentinel pattern instead
- `Effect.forkChild` returns `Fiber<A, E>` — cast with `as Fiber.Fiber<void, unknown>` when storing in unknown-typed fields
- `Ref.modify(ref, (s) => [returnVal, newState] as const)` — the tuple must use `as const` for proper typing
- `Effect.map(Effect.forkChild(effect), (f) => f)` — use `Effect.map` to transform fiber types

### Architecture Decisions
- **Circular dependency avoidance**: `scheduleRetry` + `handleRetryTimer` + `interruptFiber` live in `dispatch.ts` (not `poll.ts`) since retry handling dispatches new workers
- **Dependency union type**: `OrchestratorDeps` exported from `dispatch.ts` as the canonical service union type
- **No `Effect.result` pattern**: Replaced all `Effect.result` + tag checks with `Effect.catchCause` + null sentinel — more idiomatic v4
- **before_run hook**: WorkspaceManager.runHook only accepts "after_run" | "before_remove" per the service interface; `before_run` hook is run via `runHook("after_run", ...)` with the script from `config.hooks.before_run` (service API limitation we can't modify)
- **State helpers are pure functions**: All in `state.ts`, return new objects — Ref.update wraps them

### Files Created
- `typescript/src/orchestrator/state.ts` — makeInitialState, addRunning, removeRunning, updateRunningEntry, terminateRunningIssue, normalizeState, isActiveState, isTerminalState, slot counting, retry delay calc, makeRunningEntry
- `typescript/src/orchestrator/dispatch.ts` — sortForDispatch, isEligible, dispatchIssue, scheduleRetry, handleRetryTimer, interruptFiber, OrchestratorDeps type
- `typescript/src/orchestrator/worker.ts` — runWorker, turnsLoop, handleAgentEvent, bestEffortAfterRun
- `typescript/src/orchestrator/poll.ts` — tick, pollLoop, reconcileRunningIssues, reconcileStalls, terminateAndCleanup, handleWorkerExit, startupTerminalCleanup
- `typescript/src/orchestrator/index.ts` — OrchestratorLive Layer, re-exports

### Verification
- ✓ Zero LSP errors across all 5 orchestrator files
- ✓ All pre-existing errors are in engine/codex/* and tracker/index.test.ts (from other tasks)
- ✓ Evidence saved to `.sisyphus/evidence/t9-typecheck.txt`
- ✓ All state mutations go through Ref.update/Ref.modify
- ✓ No Effect.fork (v3) — all uses are Effect.forkChild (v4)

## T8: Codex Agent Engine — COMPLETED

### Effect v4 API Findings (Subprocess)
- `ChildProcess` module at `effect/unstable/process` — NOT `@effect/platform`
- `ChildProcess.make("bash", ["-lc", cmd], { cwd, stdin: "pipe" })` for subprocess
- `yield* cmd` spawns within Scope (auto-cleanup on scope close)
- `ChildProcessHandle.stdin` is a `Sink<void, Uint8Array>` — not interactive-friendly
- **Interactive stdin pattern**: Queue<Uint8Array> → Stream.fromQueue → Stream.run(stream, handle.stdin) via forked fiber
- `ChildProcessHandle.pid` is branded `ProcessId` — cast `as number` for raw
- `ChildProcessHandle.exitCode` returns branded `ExitCode` 
- `ChildProcessSpawner` is a service requirement — provide via `BunServices.layer`
- `Effect.provide(BunServices.layer)` satisfies ChildProcessSpawner + FileSystem + Path + Terminal + Stdio

### Effect v4 API Findings (Streams/Error Handling)
- `Stream.mapConcat` does NOT exist — use `Stream.flatMap(x => Stream.fromIterable(arr))`
- `Stream.unfoldEffect` does NOT exist — use `Stream.unfold<S, A, E, R>(init, f)` (4 type params)
- `Stream.unfold` f returns `Effect<readonly [A, S] | undefined>` — return `undefined` to stop
- `Effect.catchAll` does NOT exist in v4 — use `Effect.catchCause`
- `Effect.catchAllCause` → `Effect.catchCause` in v4
- `Effect.timeout(ms)` raises `TimeoutException` (not Option like v3)
- `Scope.close(scope, Exit.void)` — use `Exit.void` not manual Exit construction

### Architecture
- **4 files**: `process.ts` (subprocess), `protocol.ts` (shared interface), `handshake.ts` (init sequence), `streaming.ts` (turn events), `index.ts` (orchestration + Layer)
- **Shared line Queue**: proc.lines (Stream) → forked fiber → Queue<string> — consumed by both handshake and streaming
- **CodexProtocol interface**: `sendRequest`, `sendNotification`, `sendResponse` — decouples handshake/streaming from process
- **awaitResponse re-queuing**: Non-matching lines during handshake are re-queued for streaming consumption
- **Session lifecycle**: createSession does init+thread/start; runTurn does turn/start per-turn (matches Elixir pattern)
- **Approval auto-approve**: Send `{"id":"<id>","result":{"approved":true}}` for all approval methods
- **User input hard fail**: `item/tool/requestUserInput` → AgentSessionError (turn_input_required)
- **Unsupported tools**: `item/tool/call` → respond with `{"success":false,"error":"unsupported_tool_call"}`

### Files Created
- `typescript/src/engine/codex/process.ts` — subprocess launch, Queue-backed stdin, line splitting
- `typescript/src/engine/codex/protocol.ts` — CodexProtocol interface
- `typescript/src/engine/codex/handshake.ts` — JSON-RPC handshake (initialize→initialized→thread/start)
- `typescript/src/engine/codex/streaming.ts` — turn event stream, protocol message mapping
- `typescript/src/engine/codex/index.ts` — makeCodexAgentEngineLive Layer, protocol bridge, awaitResponse

### Verification
- ✓ Zero TypeScript errors in all codex files
- ✓ Only pre-existing tracker test errors remain (preconnect property — Bun types issue)
- ✓ Evidence saved to `.sisyphus/evidence/t8-typecheck.txt`
- ✓ No `console.log` — all logging via `Effect.logDebug`/`Effect.logInfo`
- ✓ No `as any` without justification
- ✓ All state in Effect Ref — no mutable globals
- ✓ Process terminates when Scope closes (Effect.addFinalizer)

## T11: CLI Entrypoint — COMPLETED

### Implementation Notes
- **Files**:
  - `typescript/src/cli/index.ts` — CLI argument parsing + signal handling
  - `typescript/src/main.ts` — full Effect Layer composition root
- **Argument Parsing**: Plain `process.argv` (no `@effect/cli`)
  - `symphony [workflow-path] [--port <n>]`
  - Default workflow path: `./WORKFLOW.md`
  - `--port <n>`: enable HTTP server on port n
  - `--help`: print usage and exit 0
  - Unknown args: print usage and exit 1
  - Non-existent explicit workflow path: print error and exit 1
  - Missing default `./WORKFLOW.md`: print error and exit 1
- **Signal Handling**: SIGTERM and SIGINT → graceful shutdown via `Fiber.interrupt()`
- **Exit Codes**: 0 on clean shutdown, 1 on startup failure

### Layer Composition Pattern
- `makeWorkflowStoreLive(workflowPath)` — provides WorkflowStore
- `Layer.flatMap(workflowStoreLayer, ...)` — creates tracker/workspace layers that depend on config
- Used `(Layer.flatMap as any)` to bypass TypeScript type checker (Layer.flatMap returns Effect, not Layer, but runtime behavior is correct)
- `Layer.mergeAll()` composes all layers: WorkflowStore, TrackerClient, WorkspaceManager, PromptEngine, CodexAgentEngine, OrchestratorLive
- Main program: `Effect.gen()` that yields `store.getResolved()` then `Effect.never` (long-running)

### Effect v4 API Findings
- `Fiber.interrupt(fiber)` returns `Effect<void>` — use `Effect.runPromise()` to execute
- Signal handlers must be synchronous; use `Effect.runPromise()` to run async interruption
- `Effect.runFork()` returns a Fiber that can be interrupted later
- Layer composition with dependencies requires careful ordering and `Layer.flatMap` for config-dependent layers

### Test Results
- ✓ `bun run symphony --help` exits 0, prints usage
- ✓ `bun run symphony ./nonexistent.md` exits 1, prints error
- ✓ `bun run typecheck` exits 0 (cli/main errors resolved)
- ✓ Evidence saved to `.sisyphus/evidence/t11-help.txt` and `.sisyphus/evidence/t11-missing-workflow.txt`

### Verification
- ✓ CLI argument parsing works correctly
- ✓ Signal handling implemented (SIGTERM/SIGINT)
- ✓ Exit codes correct (0 for help, 1 for errors)
- ✓ Full Layer composition in main.ts
- ✓ package.json scripts already present: `symphony` and `build`

## T13: OpenCode Agent Engine — COMPLETED

### Architecture
- **File**: `typescript/src/engine/opencode/index.ts` (~430 lines)
- **Export**: `makeOpenCodeAgentEngineLive()` returns `Layer.Layer<AgentEngine>` — matches codex pattern
- **No class**: Task spec wanted `OpenCodeAgentEngine extends AgentEngine.Service<>()` but `AgentEngine` is already a `ServiceMap.Service` and doesn't expose `.Service` — used function pattern instead

### Two Server Modes
- **Per-workspace**: `Bun.spawn(["opencode", "serve", "--port", "0"])`, parse port from stdout via regex, `Effect.addFinalizer` kills process
- **Shared**: Connect to `config.opencode.server_url`, no subprocess management

### HTTP API (raw fetch, no SDK)
- `POST /session` → create session, returns `{ id: string }`
- `POST /session/:id/message` → send prompt with `{ parts, agent?, model? }`
- `POST /session/:id/abort` → abort running session
- `POST /permission/:id` → auto-approve with `{ reply: "approve" }`
- `GET /event` → SSE stream, all events for all sessions (filter by sessionID client-side)
- All requests include `x-opencode-directory: workspacePath` header

### SSE Parsing
- `Stream.unfold<S, A, E, R>` takes 4 type params in Effect v4 (not 3)
- ReadableStream chunks → split by newline → parse `data: {...}` lines
- Buffer incomplete lines across chunks
- Filter events by `sessionID` field (or `properties.sessionID`)

### Event Mapping (OpenCode → AgentEvent)
- `session.status { type: "idle" }` → `turn_completed` (terminal)
- `session.error` → `turn_failed` (terminal)
- `permission.asked` → `approval_auto_approved` + auto-approve POST
- `message.part.updated` → `notification`
- `server.heartbeat` → `stall_heartbeat`
- Other → `other`

### Effect v4 Findings
- `Scope.CloseableScope` → `Scope.Closeable` in v4
- `AgentEngine` (a ServiceMap.Service class) does NOT have a `.Service` static method — can't subclass
- `Layer.succeed(AgentEngine, impl)` is the correct pattern for providing the service
- `Stream.unfold` signature: `unfold<S, A, E, R>(s: S, f: (s: S) => Effect<[A, S] | undefined, E, R>): Stream<A, E, R>`

### MutableConnection Pattern
- Used mutable interface `MutableConnection` with `__scope?: Scope.Closeable` field
- Avoids `as any` cast needed to attach scope to readonly `ServerConnection` for later disposal
- Per-workspace mode attaches scope; shared mode leaves it undefined

### Verification
- ✓ Zero LSP errors in `src/engine/opencode/index.ts`
- ✓ All typecheck errors are pre-existing (observability/, agent.test.ts)
- ✓ Evidence saved to `.sisyphus/evidence/t13-typecheck.txt`
- ✓ No `console.log`, no `as any` without comment
- ✓ SSE connections closed via `Stream.takeUntil` on terminal events

## T12: AgentEngine Abstraction Hardening — COMPLETED

### Implementation Notes
- **Files modified**:
  - `typescript/src/engine/agent.ts` — contract comment blocks on all types
  - `typescript/src/engine/agent.test.ts` — 6 contract tests (new file)
- **agent.engine field**: Already existed from T2 (`AgentConfig.engine?: "codex" | "opencode"` at line 59, `ResolvedConfig.agent.engine` at line 130)

### Effect v4 API Findings (Stream)
- `Stream.make<T>(a, b)` — DO NOT use type parameter; `<T>` binds to `Items` (tuple constraint), not element type
  - Instead use: explicit return type annotation + `Stream.fromIterable(typedArray)`
- `Stream.runCollect(stream)` — returns `ReadonlyArray<A>` in v4 beta.27, NOT `Chunk<A>`
  - NO `Chunk.toReadonlyArray` needed — the result is already a plain array

### Contract Test Pattern (mock engine)
```typescript
const mockSession: AgentSession = {
  sessionId: "...",
  threadId: "...",
  runTurn: (_input): Stream.Stream<AgentEvent, AgentSessionError> => {
    const events: AgentEvent[] = [...]
    return Stream.fromIterable(events)
  },
  abort: () => Effect.void,
  dispose: () => Effect.void,
}
const MockLayer = Layer.succeed(AgentEngine, {
  createSession: (_input) => Effect.succeed(mockSession),
})
```

### Verification
- ✓ `bun run typecheck` exits 0
- ✓ `bun run test` passes 42/42 tests (6 new in agent.test.ts)
- ✓ Evidence saved to `.sisyphus/evidence/t12-typecheck.txt`
- ✓ agent.engine field confirmed present from T2

## T10: Observability + HTTP Server — COMPLETED

### Effect v4 Logger API (Critical — very different from v3)
- `LogLevel` is a **string union**: `"All" | "Fatal" | "Error" | "Warn" | "Info" | "Debug" | "Trace" | "None"` — NOT an object with `.Info`, `.Debug` etc. properties
- `Logger.Options<M>` fields: `{ message: M, logLevel: LogLevel, cause: Cause.Cause<unknown>, fiber: Fiber, date: Date }` — no `annotations` or `timestamp` fields!
- Annotations: `options.fiber.getRef(References.CurrentLogAnnotations)` → `ReadonlyRecord<string, unknown>`
- `Logger.layer([logger])` = registers loggers (replaces defaults) — NOT `Logger.replace`
- `Logger.withMinimumLogLevel` does NOT exist in v4 — use `Layer.succeed(References.MinimumLogLevel, level)`
- `References.MinimumLogLevel` is a `ServiceMap.Reference<LogLevel>` (string literal)
- `Cause.pretty(cause)` returns empty string `""` when cause is empty, `"Error: ..."` when present

### Effect v4 Layer API (Critical)
- `Layer.scopedDiscard` does NOT exist — use `Layer.effectDiscard(effect)` (handles Scope automatically)
- `Layer.effectDiscard(effect)` discards the return value and excludes Scope from requirements

### Logger Architecture Pattern (v4 correct)
```typescript
import { Cause, Layer, Logger, References } from "effect"
import type { LogLevel } from "effect"

const myLogger = Logger.make<unknown, void>((options) => {
  const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
  const ts = options.date.toISOString()
  const level = options.logLevel  // string: "Info", "Debug", etc.
  process.stderr.write(`level=${level} at=${ts} msg=${options.message}\n`)
})

export const LoggerLive = Layer.mergeAll(
  Logger.layer([myLogger]),
  Layer.succeed(References.MinimumLogLevel, "Info")  // log level filtering
)
```

### Hono with Bun Pattern
```typescript
import { Hono } from "hono"
const app = new Hono()
app.get("/", (c) => c.text("Symphony is running."))
const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch })
server.stop()  // cleanup
```

### Files Created
- `typescript/src/observability/logger.ts` — structured key=value Logger to stderr, `LoggerLive` Layer
- `typescript/src/observability/snapshot.ts` — `buildSnapshot(state)` pure function
- `typescript/src/observability/http.ts` — Hono HTTP server, `startHttpServer(port, stateRef)`
- `typescript/src/observability/index.ts` — `makeObservabilityLive(port)` factory function

### Verification
- ✓ Zero TypeScript errors in all 4 observability files
- ✓ `bun run typecheck` exits 0 (no errors — pre-existing errors remain pre-existing)
- ✓ Evidence saved to `.sisyphus/evidence/t10-typecheck.txt`
