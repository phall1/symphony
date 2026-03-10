# Symphony TypeScript+Effect Codebase Review

**Scope**: Design smells, code smells, and missed opportunities to use Effect idiomatically.
**Status of codebase**: Functional, 129 tests passing, typechecks clean. This is not a correctness review.
**Tone**: Direct. Every finding references actual code in this repo.

---

## Severity Levels

- **CRITICAL**: Breaks Effect's core guarantees (interruption, supervision, typed errors)
- **HIGH**: Defeats the purpose of a pattern that's already in use
- **MEDIUM**: Unnecessary complexity or hidden risk
- **LOW**: Minor cleanup, no behavioral impact

---

## CRITICAL

### 1. `Effect.runPromise` in production code breaks the fiber model

**Files**: `src/observability/http.ts` lines 12, 38, 45, 107 | `src/config/watcher.ts` line 17

`Effect.runPromise` creates a brand-new fiber root. It has no parent, no access to the ambient service environment, and can't be interrupted by the program's supervision tree. Using it inside route handlers and file-watcher callbacks means those operations are effectively orphaned from the rest of the program.

In `http.ts`, four Hono route handlers do this:

```typescript
// BEFORE — http.ts (repeated 4 times)
app.get("/state", async (c) => {
  const state = await Effect.runPromise(Ref.get(stateRef));
  return c.json(state);
});
```

When the HTTP server shuts down, these in-flight `runPromise` calls keep running. There's no way to cancel them. If `Ref.get(stateRef)` were replaced with something that uses a service (say, a database call), it would fail because the new fiber root has no services.

In `watcher.ts`, the chokidar callback does:

```typescript
// BEFORE — watcher.ts
watcher.on("change", (path) => {
  Effect.runPromise(reloadConfig(path)).catch((err) => {
    console.error("Config reload failed:", err);
  });
});
```

The `.catch()` here is the tell: errors are escaping Effect's typed error channel and being handled as raw Promise rejections. The reload can't be interrupted, and if it fails with a defect, the `.catch()` swallows it as a plain `unknown`.

The fix is to capture a `Runtime` during setup and use it in the callbacks. `Effect.runtime()` returns the current runtime (with all services and the fiber's scope), and `Runtime.runPromise(rt)(effect)` runs an effect within that runtime context.

```typescript
// AFTER — http.ts
const startHttpServer = Effect.gen(function* () {
  const rt = yield* Effect.runtime<OrchestratorStateRef>();
  const runP = Runtime.runPromise(rt);

  app.get("/state", async (c) => {
    const state = await runP(
      Effect.gen(function* () {
        const { ref } = yield* OrchestratorStateRef;
        return yield* Ref.get(ref);
      })
    );
    return c.json(state);
  });
  // ...
});
```

```typescript
// AFTER — watcher.ts
const startWatcher = Effect.gen(function* () {
  const rt = yield* Effect.runtime<WorkflowStore>();
  const runP = Runtime.runPromise(rt);

  watcher.on("change", (path) => {
    runP(reloadConfig(path)).catch((err) =>
      console.error("Config reload failed:", err)
    );
  });
});
```

The `.catch()` on the Promise is still there in the "after" because Hono and chokidar are callback-based boundaries that can't be made fully Effect-native. That's fine. The difference is that `runP` uses the program's runtime, so the effect has access to services, participates in the fiber tree, and can be interrupted when the program shuts down.

---

### 2. Plain error interfaces instead of `Data.TaggedError`

**Files**: `src/types.ts` lines 265-353 | `src/engine/agent.ts` lines 20-41

All seven domain error types (`WorkflowError`, `ConfigError`, `TrackerError`, `WorkspaceError`, `AgentError`, `PromptError`) are plain TypeScript interfaces with a manually typed `_tag` field. The two engine errors (`AgentEngineError`, `AgentSessionError`) follow the same pattern.

```typescript
// BEFORE — types.ts
export interface TrackerError {
  readonly _tag: "TrackerError";
  readonly code: TrackerErrorCode; // "linear_api_request" | "linear_api_status" | ...
  readonly message: string;
  readonly cause?: unknown;
}

// Construction at call sites (linear.ts:166, 172, 176, 182, etc.)
throw { _tag: "TrackerError", code: "linear_api_status", message: `Linear API returned HTTP ${response.status}` };
```

This approach has four concrete problems:

1. **`Effect.catchTag` won't work.** `catchTag` requires `Data.TaggedError` subclasses. It checks `instanceof` internally. Plain objects fail this check silently, so any `catchTag("TrackerError", ...)` call in this codebase is a latent bug waiting to surface.

2. **No structural equality.** Two `TrackerError` objects with identical fields are not `Equal.equals` to each other. This matters for deduplication, caching, and testing.

3. **No `instanceof` checks.** You can't write `if (e instanceof TrackerError)` in a catch block or type guard.

4. **Manual construction is fragile.** A typo in `_tag: "TrackerErro"` compiles fine and produces a value that no error handler will ever match.

`Data.TaggedError` solves all of this. The `_tag` is derived from the class name, construction is type-safe, and you get `instanceof`, structural equality, and `Cause` integration for free.

```typescript
// AFTER — types.ts
import { Data } from "effect";

export class TrackerError extends Data.TaggedError("TrackerError")<{
  readonly code: TrackerErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Construction at call sites
new TrackerError({ code: "linear_api_status", message: `Linear API returned HTTP ${response.status}` });
```

With this change, surgical error recovery becomes possible:

```typescript
// AFTER — error handling
yield* tracker.fetchCandidateIssues().pipe(
  Effect.catchTag("TrackerError", (e) =>
    e.code === "linear_api_status"
      ? Effect.logWarning("Linear API error, retrying after delay").pipe(
          Effect.andThen(Effect.sleep("10 seconds")),
          Effect.andThen(tracker.fetchCandidateIssues())
        )
      : Effect.fail(e)
  )
);
```

The current pattern of `Effect.catchCause(() => ...)` with manual tag checks is working around the absence of proper tagged errors. Fix the errors, and the error handling simplifies everywhere.

---

## HIGH

### 3. Config threaded manually through ~18 function parameters

**Files**: `src/orchestrator/dispatch.ts` lines 116, 157, 205, 278 | `src/orchestrator/poll.ts` lines 34, 55, 128, 169, 242, 277 | `src/orchestrator/worker.ts` lines 8, 90

`config: ResolvedConfig` is passed as an explicit parameter to 18+ functions across the orchestrator. The config is fetched once at the top of `tick()` via `WorkflowStore.getResolved()` and then manually threaded through every subsequent call.

This defeats the purpose of the service layer. Services exist precisely so you don't have to pass cross-cutting dependencies through every function signature. When `dispatchIssue` takes `config` as a parameter, every caller of `dispatchIssue` must also have `config` in scope, which means every caller's caller must too. The dependency propagates upward through the entire call tree.

There's also a subtle correctness issue: config can change between ticks (the file watcher reloads it). If `tick()` fetches config once and passes it down, all functions in that tick see a consistent snapshot. But if any function later calls `WorkflowStore.getResolved()` directly, it might see a newer config. The current approach is actually correct about consistency, but it achieves it through manual discipline rather than structure.

The idiomatic fix is a per-tick `CurrentConfig` service:

```typescript
// AFTER — a thin service for the current tick's config
class CurrentConfig extends ServiceMap.Service<CurrentConfig>()(
  "CurrentConfig",
  { accessors: true }
) {}

// In tick():
const tick = Effect.gen(function* () {
  const store = yield* WorkflowStore;
  const config = yield* store.getResolved();

  yield* runTickWork().pipe(
    Effect.provide(Layer.succeed(CurrentConfig, config))
  );
});

// In any function that needs config:
const dispatchIssue = (issue: Issue) =>
  Effect.gen(function* () {
    const config = yield* CurrentConfig;
    // ...
  });
```

Now `dispatchIssue`'s signature is `(issue: Issue) => Effect<void, ..., CurrentConfig>`. The dependency is declared in the type, not hidden in a parameter. Functions that don't need config don't mention it at all.

---

### 4. `stateRef` passed as parameter despite `OrchestratorStateRef` service existing

**Files**: `src/orchestrator/dispatch.ts`, `src/orchestrator/poll.ts`, `src/orchestrator/worker.ts` — every function signature

`OrchestratorStateRef` is a service that holds `{ ref, pollTrigger }`. In `orchestrator/index.ts:34`, the `ref` is extracted from the service and then passed manually to every function:

```
tick(stateRef)
  pollLoop(stateRef, pollTrigger)
  dispatchIssue(stateRef, issue, config, ...)
  scheduleRetry(stateRef, issueId, ...)
  handleRetryTimer(stateRef, issueId, ...)
  reconcileStalls(stateRef, config)
  terminateAndCleanup(stateRef, issueId, ...)
  handleWorkerExit(stateRef, issueId, ...)
  runWorker(stateRef, issueId, ...)
```

That's nine functions, all taking `stateRef` as their first parameter. The service exists. The ref is in the service. There is no reason to extract it and pass it manually.

```typescript
// BEFORE — dispatch.ts
export const dispatchIssue = (
  stateRef: Ref.Ref<OrchestratorState>,
  issue: Issue,
  config: ResolvedConfig,
  // ...
) => Effect.gen(function* () {
  const state = yield* Ref.get(stateRef);
  // ...
});
```

```typescript
// AFTER — dispatch.ts
export const dispatchIssue = (
  issue: Issue,
  // config removed too, per Finding 3
) => Effect.gen(function* () {
  const { ref: stateRef } = yield* OrchestratorStateRef;
  const state = yield* Ref.get(stateRef);
  // ...
});
```

The function's Effect type now declares its dependency: `Effect<void, ..., OrchestratorStateRef>`. This is better than a parameter because it's visible in the type, composable with `Effect.provide`, and testable by providing a mock service. A parameter is just a hidden dependency that the type system can't help you with.

Combined with Finding 3, removing both `stateRef` and `config` parameters would cut the argument lists of most orchestrator functions in half.

---

### 5. `while(true)` loops instead of `Effect.repeat` / `Schedule`

**Files**: `src/orchestrator/poll.ts:112` | `src/orchestrator/worker.ts:105` | `src/engine/codex/index.ts:59` | `src/engine/opencode/index.ts:228`

Several places use the pattern:

```typescript
// BEFORE — poll.ts
const pollLoop = (stateRef, pollTrigger) =>
  Effect.gen(function* () {
    while (true) {
      yield* tick(stateRef);
      yield* Effect.sleep("5 seconds");
    }
  });
```

This works, but it opts out of Effect's interruption model in a subtle way. When a fiber running this loop is interrupted, Effect will interrupt at the next `yield*` point. That's fine for `Effect.sleep`, but the `while(true)` structure means the loop itself has no natural termination condition and no way to communicate "I'm done" to the scheduler. It also makes the loop harder to test (you can't easily run it for N iterations) and harder to compose (you can't add backoff or jitter without restructuring the loop).

`Effect.repeat` with `Schedule` is the idiomatic replacement:

```typescript
// AFTER — poll.ts
const pollLoop = Effect.gen(function* () {
  const { ref: stateRef, pollTrigger } = yield* OrchestratorStateRef;

  const tickOrTrigger = Effect.race(
    tick(stateRef),
    Queue.take(pollTrigger).pipe(Effect.andThen(tick(stateRef)))
  );

  yield* Effect.repeat(tickOrTrigger, Schedule.spaced("5 seconds"));
});
```

`Schedule.spaced` runs the effect, waits the interval, then runs again. It's interruptible at every boundary. You can compose it: `Schedule.spaced("5 seconds").pipe(Schedule.jittered)` adds jitter. `Schedule.recurWhile(condition)` stops when a condition is false. None of this is possible with `while(true)`.

One note: the `awaitResponse` loop in `codex/index.ts:59` is scanning a buffer for a matching ID. That's a search loop, not a schedule pattern. Leave it as-is.

---

### 6. Non-atomic Ref operations (get then update race conditions)

**Files**: `src/orchestrator/poll.ts` lines 83, 139-140, 177, 196, 219, 241, 249 | `src/orchestrator/dispatch.ts` lines 165-166, 241, 266-267

The pattern appears throughout the orchestrator:

```typescript
// BEFORE — dispatch.ts (scheduleRetry)
const state = yield* Ref.get(stateRef);
const existing = state.retry_attempts.get(issueId);
// ... some logic using existing ...
yield* Ref.update(stateRef, (s) => ({
  ...s,
  retry_attempts: s.retry_attempts.set(issueId, newEntry),
}));
```

Between `Ref.get` and `Ref.update`, another fiber can modify the ref. This is a classic TOCTOU (time-of-check-time-of-use) race. In the orchestrator, multiple fibers run concurrently: the poll loop, retry timers, and worker exit handlers all touch the same `stateRef`. The race is real, not theoretical.

`Ref.modify` is atomic. It reads and writes in a single operation, with no window for another fiber to interleave:

```typescript
// AFTER — dispatch.ts (scheduleRetry)
const existing = yield* Ref.modify(stateRef, (s) => [
  s.retry_attempts.get(issueId),
  s, // no change yet — we're just reading atomically
]);

// ... compute newEntry from existing ...

yield* Ref.update(stateRef, (s) => ({
  ...s,
  retry_attempts: s.retry_attempts.set(issueId, newEntry),
}));
```

Better still, if the read and write are logically one operation, collapse them entirely:

```typescript
// AFTER — fully atomic
yield* Ref.modify(stateRef, (s) => {
  const existing = s.retry_attempts.get(issueId);
  const newEntry = computeNewEntry(existing);
  return [
    newEntry,
    { ...s, retry_attempts: s.retry_attempts.set(issueId, newEntry) },
  ];
});
```

The cases in `poll.ts:83-84` (checking available slots before dispatching) and `poll.ts:196-199` (reading a running entry then using it) are the highest-risk instances. A slot check that races with a dispatch could allow over-scheduling. An entry read that races with a worker exit could operate on a stale entry.

---

## MEDIUM

### 7. `graphqlRequest` is a plain `async` function outside the Effect world

**File**: `src/tracker/linear.ts` lines 145-186

`graphqlRequest` is a plain `async function` that throws plain objects. Every Effect-based caller wraps it:

```typescript
// BEFORE — linear.ts (call sites, e.g. fetchCandidateIssues at line 196)
return Effect.tryPromise({
  try: async () => {
    // ... while(true) loop calling graphqlRequest(endpoint, apiKey, query, vars) ...
  },
  catch: (error) => {
    if (error !== null && typeof error === "object" && "_tag" in error) return error as TrackerError;
    return { _tag: "TrackerError" as const, code: "linear_api_request" as const, message: String(error), cause: error };
  }
});
```

The `catch` handler manually checks for `_tag` and casts — a brittle pattern. `graphqlRequest` itself (line 145) is a plain `async function` that throws plain objects with `_tag: "TrackerError"`. If the function throws something unexpected (a network error, a JSON parse failure from an unexpected response shape), the manual error mapping is the only thing standing between you and a malformed error object.

The function also manages its own timeout via `AbortController` and `setTimeout`. This timeout is invisible to Effect's fiber runtime. If the fiber is interrupted, the `AbortController` abort may or may not fire depending on timing.

Rewriting as an Effect function fixes all of this:

```typescript
// AFTER — linear.ts
const graphqlRequest = (
  endpoint: string,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>
): Effect.Effect<unknown, TrackerError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ query, variables }),
        }),
      catch: (cause) =>
        new TrackerError({ code: "linear_api_request", message: "Linear API request failed", cause }),
    });

    if (!response.ok) {
      return yield* Effect.fail(
        new TrackerError({ code: "linear_api_status", message: `Linear API returned HTTP ${response.status}` })
      );
    }

    const json = yield* Effect.tryPromise({
      try: () => response.json() as Promise<Record<string, unknown>>,
      catch: (cause) =>
        new TrackerError({ code: "linear_api_request", message: "JSON parse failed", cause }),
    });

    if (json["errors"]) {
      return yield* Effect.fail(
        new TrackerError({ code: "linear_graphql_errors", message: `GraphQL errors: ${JSON.stringify(json["errors"])}`, cause: json["errors"] })
      );
    }

    return json["data"];
  }).pipe(Effect.timeout("30 seconds"));
```

`Effect.timeout` replaces `AbortController`. The timeout is now part of the fiber's lifecycle and will be cancelled if the fiber is interrupted. The error types are real (assuming Finding 2 is addressed). Call sites no longer need `Effect.tryPromise` wrappers.

---

### 8. `Layer.unwrap` used three times just to extract config

**File**: `src/main.ts` lines 15-40

`Layer.unwrap` is a power tool. It's for cases where you need to run an Effect to decide which Layer to build, like choosing between two different implementations at runtime. Using it three times just to pass config to layer factories is overkill.

```typescript
// BEFORE — main.ts (repeated pattern)
const trackerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const config = yield* store.getResolved();
    return makeLinearTrackerClientLive(config);
  })
).pipe(Layer.provide(workflowStoreLayer));
```

The fix is to move config access into the layer implementations themselves. A layer is just an Effect that builds a service. It can `yield* WorkflowStore` directly.

```typescript
// AFTER — linear.ts (layer factory)
export const LinearTrackerClientLive = Layer.effect(
  LinearTrackerClient,
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const config = yield* store.getResolved();
    return makeLinearTrackerClient(config);
  })
);

// AFTER — main.ts
const trackerLayer = LinearTrackerClientLive.pipe(
  Layer.provide(workflowStoreLayer)
);
```

No `Layer.unwrap`. The layer declares its dependency on `WorkflowStore` in its type, and `Layer.provide` satisfies it. Keep `Layer.unwrap` only for the agent engine layer where there's genuine runtime branching between codex and opencode.

---

### 9. Silent error swallowing with `Effect.catchCause(() => Effect.void)`

**Files**: `src/orchestrator/worker.ts` lines 67, 73, 84-87 | `src/orchestrator/poll.ts` lines 230-233, 295-296 | `src/orchestrator/dispatch.ts` lines 273-276 | `src/engine/codex/index.ts:131` | `src/engine/opencode/index.ts` lines 327, 460

`Effect.catchCause` catches everything: expected errors, unexpected exceptions (`Cause.Die`), and interruptions (`Cause.Interrupt`). Using it to silently return `Effect.void` means bugs are invisible.

```typescript
// BEFORE — worker.ts
yield* session.dispose().pipe(
  Effect.catchCause(() => Effect.void)
);
```

If `session.dispose()` throws an unexpected exception (a defect), this swallows it. The session may be in a broken state, resources may be leaked, and there's no trace of what happened.

```typescript
// AFTER — worker.ts
yield* session.dispose().pipe(
  Effect.catchCause((cause) =>
    Effect.logDebug("session dispose failed (best-effort)").pipe(
      Effect.annotateLogs({ cause: Cause.pretty(cause) })
    )
  )
);
```

For truly fire-and-forget operations where you genuinely don't care about failure, `Effect.ignore` is more honest than `catchCause(() => void)` because it only ignores typed errors, not defects. If you want to ignore defects too, at least log them.

The `codex/index.ts:131` case (line reader fiber) is particularly risky. If the line reader silently dies, the agent will hang waiting for output that never comes. A log line here would make debugging much faster.

---

### 10. `worker_fiber` and `timer_handle` typed as `unknown`

**File**: `src/types.ts` lines 232-233, 243

```typescript
// BEFORE — types.ts
export interface RunningEntry {
  // ...
  worker_fiber: unknown; // typed as unknown to avoid circular deps; cast at use site
}

export interface RetryEntry {
  // ...
  timer_handle: unknown; // typed as unknown to avoid circular deps; cast at use site
}
```

And at the use sites:

```typescript
// BEFORE — dispatch.ts
worker_fiber: null as unknown as Fiber.Fiber<void, unknown>
// ...
Fiber.interrupt(fiber as Fiber.Fiber<unknown, unknown>)
```

The comment says "circular deps" but `Fiber.Fiber` is a core Effect type. There's no circular dependency in importing it into `types.ts`. The `effect` package is already a dependency. This is a false constraint.

```typescript
// AFTER — types.ts
import type { Fiber } from "effect";

export interface RunningEntry {
  // ...
  worker_fiber: Fiber.Fiber<void, unknown> | null;
}

export interface RetryEntry {
  // ...
  timer_handle: Fiber.Fiber<void, never> | null;
}
```

All the `as unknown as` casts at use sites disappear. TypeScript can now verify that you're calling `Fiber.interrupt` on an actual fiber, not an arbitrary `unknown`. If there is a genuine circular dependency somewhere, the fix is to move the fiber-aware types to a separate file, not to lie to the type system.

---

## LOW

### 11. `as Effect.Effect<void>` cast in `main.ts:76`

`Effect.never` has return type `never`. The cast to `Effect.Effect<void>` is technically harmless but can be written more clearly:

```typescript
// BEFORE
const program = Effect.never as Effect.Effect<void>;

// AFTER
const program = Effect.never.pipe(Effect.asVoid);
```

---

### 12. `process.stderr.write` in `config/index.ts:27`

Direct stderr write bypasses Effect's logging infrastructure. Use `Effect.logError` or `Effect.logWarning` so the output participates in the program's log filtering and formatting.

---

### 13. Mutable closure variables in SSE parser (`opencode/index.ts:218-220`)

```typescript
let buffer = "";
let streamDone = false;

const stream = Stream.unfold(initialState, (state) => { ... });
```

`Stream.unfold` is sequential, so this works correctly in practice. But mutable variables captured by a closure are against the spirit of Effect's model. The state should live in the unfold's state parameter:

```typescript
const stream = Stream.unfold(
  { buffer: "", done: false },
  ({ buffer, done }) => { ... }
);
```

This makes the state explicit, immutable, and visible in the type.

---

## Summary and Prioritized Action List

The codebase is well-structured and the Effect usage is mostly correct. The issues are about leverage: Effect provides powerful tools for error handling, service injection, concurrency, and scheduling, and this codebase is leaving most of them on the table.

**Priority order:**

1. **Errors to `Data.TaggedError`** (Finding 2). This is the highest-leverage change. It unblocks `Effect.catchTag`, enables `instanceof` checks, and eliminates the manual tag discrimination pattern that appears everywhere. Do this first because it changes the error types that everything else depends on.

2. **Remove manual `config` and `stateRef` parameter threading** (Findings 3 and 4). These two changes together would remove 2-3 parameters from ~18 function signatures. The orchestrator code becomes dramatically easier to read and test. Do them together since they affect the same files.

3. **Fix `Effect.runPromise` escape hatches** (Finding 1). Capture `Runtime` during setup and use `Runtime.runPromise` in callbacks. This restores structured concurrency and clean shutdown for the HTTP server and config watcher.

4. **`while(true)` to `Schedule.repeat`** (Finding 5). Straightforward mechanical change. Improves interruptibility and opens the door to jitter, backoff, and conditional scheduling.

5. **Non-atomic Ref ops to `Ref.modify`** (Finding 6). Audit every `Ref.get` followed by `Ref.update` in the orchestrator and collapse them. The slot-check and entry-read cases are the highest risk.

6. **`graphqlRequest` to Effect** (Finding 7). Eliminates the `Effect.tryPromise` wrapper boilerplate at every call site and makes the timeout fiber-aware.

7. **`Layer.unwrap` cleanup** (Finding 8). Small change, cleaner main.ts. Move config access into the layer implementations.

8. **Silent error swallowing** (Finding 9). Add `Effect.logDebug` to every `catchCause(() => Effect.void)`. This is a debugging quality-of-life change that will pay off the first time something breaks silently.

9. **Type the fiber handles properly** (Finding 10). Remove the `unknown` types and `as unknown as` casts. Import `Fiber` from `effect` in `types.ts`.

10. **Minor cleanups** (Findings 11-13). Low effort, low impact. Do them in a single pass.
