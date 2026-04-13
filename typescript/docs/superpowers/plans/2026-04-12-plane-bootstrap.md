# Plane Idempotent Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bun run plane:up` go from zero to a fully running local Plane + Symphony stack with test issues, requiring no manual setup steps and no pre-existing env vars beyond optional overrides.

**Architecture:** Extract a new `src/dev/plane-bootstrap.ts` module containing all the Plane onboarding API calls (admin signup, workspace creation, project creation, API token generation, issue seeding). The existing `plane.ts` orchestrator calls `ensurePlaneBootstrap()` after Docker is up and before UI build. Bootstrap state is persisted to `.plane-dev/bootstrap.json` so it's fully idempotent — if the file exists and the API key still works, skip everything.

**Tech Stack:** Bun, fetch (form POST + JSON), existing `plane.ts` infrastructure (waitFor, etc.)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/dev/plane-bootstrap.ts` | Create | All Plane onboarding: admin signup, sign-in (cookie), workspace create, project create, API token create, seed issues. Exports `ensurePlaneBootstrap(settings): Promise<BootstrapResult>` |
| `src/dev/plane.ts` | Modify | Remove `requireEnv` for `PLANE_API_KEY` / `PLANE_WORKSPACE_SLUG` / `PLANE_PROJECT_ID`. Make those optional in `Settings`. Call `ensurePlaneBootstrap()` inside `ensureStackUp()` after Docker is up. Use bootstrap result to fill in settings. Update `loadSettings()` to read from `.plane-dev/bootstrap.json` as fallback. |
| `src/dev/plane-bootstrap.test.ts` | Create | Tests for bootstrap logic with mocked fetch |

---

### Task 1: Create plane-bootstrap.ts with types and constants

**Files:**
- Create: `typescript/src/dev/plane-bootstrap.ts`

- [ ] **Step 1: Create the file with types and constants**

```typescript
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type BootstrapResult = {
  readonly apiKey: string
  readonly workspaceSlug: string
  readonly projectId: string
  readonly adminEmail: string
  readonly bootstrappedAt: string
}

type BootstrapState = BootstrapResult & {
  readonly version: 1
}

type InstanceStatus = {
  readonly instance?: {
    readonly is_setup_done?: boolean
    readonly workspaces_exist?: boolean
  }
}

type Workspace = {
  readonly id: string
  readonly slug: string
  readonly name: string
}

type Project = {
  readonly id: string
  readonly identifier: string
  readonly name: string
}

type State = {
  readonly id: string
  readonly name: string
  readonly group: string
}

type ApiToken = {
  readonly id: string
  readonly token: string
  readonly label: string
}

const BOOTSTRAP_FILE = "bootstrap.json"
const ADMIN_EMAIL = "admin@symphony.local"
const ADMIN_PASSWORD = "Symphony!Dev2026#"
const ADMIN_FIRST_NAME = "Symphony"
const ADMIN_LAST_NAME = "Admin"
const COMPANY_NAME = "Symphony Dev"
const WORKSPACE_NAME = "Symphony"
const WORKSPACE_SLUG = "symphony"
const PROJECT_NAME = "Symphony Test"
const PROJECT_IDENTIFIER = "SYM"
const API_TOKEN_LABEL = "symphony-dev"
```

- [ ] **Step 2: Commit**

```bash
git add typescript/src/dev/plane-bootstrap.ts
git commit -m "feat(plane): add bootstrap types and constants"
```

---

### Task 2: Implement bootstrap state persistence (read/write)

**Files:**
- Modify: `typescript/src/dev/plane-bootstrap.ts`
- Create: `typescript/src/dev/plane-bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

Create `typescript/src/dev/plane-bootstrap.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("plane-bootstrap", () => {
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `plane-bootstrap-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test("readBootstrapState returns null when no file exists", async () => {
    const { readBootstrapState } = await import("./plane-bootstrap.js")
    const result = await readBootstrapState(testDir)
    expect(result).toBeNull()
  })

  test("writeBootstrapState writes and readBootstrapState reads back", async () => {
    const { readBootstrapState, writeBootstrapState } = await import("./plane-bootstrap.js")
    const state = {
      apiKey: "pk_test_123",
      workspaceSlug: "symphony",
      projectId: "proj-uuid",
      adminEmail: "admin@symphony.local",
      bootstrappedAt: "2026-04-12T00:00:00.000Z",
    }
    await writeBootstrapState(testDir, state)
    const read = await readBootstrapState(testDir)
    expect(read).toEqual(state)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/Patrick.Hall/workspace/symphony/typescript && bun run test -- src/dev/plane-bootstrap.test.ts`
Expected: FAIL — `readBootstrapState` and `writeBootstrapState` not exported

- [ ] **Step 3: Implement persistence functions in plane-bootstrap.ts**

Add to `plane-bootstrap.ts`:

```typescript
export async function readBootstrapState(stateDir: string): Promise<BootstrapResult | null> {
  try {
    const raw = await readFile(join(stateDir, BOOTSTRAP_FILE), "utf8")
    const parsed = JSON.parse(raw) as BootstrapState
    if (parsed.version !== 1 || !parsed.apiKey || !parsed.workspaceSlug || !parsed.projectId) {
      return null
    }
    return {
      apiKey: parsed.apiKey,
      workspaceSlug: parsed.workspaceSlug,
      projectId: parsed.projectId,
      adminEmail: parsed.adminEmail,
      bootstrappedAt: parsed.bootstrappedAt,
    }
  } catch {
    return null
  }
}

export async function writeBootstrapState(stateDir: string, result: BootstrapResult): Promise<void> {
  const state: BootstrapState = { ...result, version: 1 }
  await writeFile(join(stateDir, BOOTSTRAP_FILE), JSON.stringify(state, null, 2), "utf8")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/Patrick.Hall/workspace/symphony/typescript && bun run test -- src/dev/plane-bootstrap.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add typescript/src/dev/plane-bootstrap.ts typescript/src/dev/plane-bootstrap.test.ts
git commit -m "feat(plane): add bootstrap state persistence"
```

---

### Task 3: Implement Plane API helpers (form auth + JSON)

**Files:**
- Modify: `typescript/src/dev/plane-bootstrap.ts`

- [ ] **Step 1: Add the HTTP helper functions**

These handle the two auth patterns Plane uses — form POST for admin signup/signin (with cookie extraction), and JSON API calls with session cookie auth.

```typescript
async function planeFormPost(
  baseUrl: string,
  path: string,
  body: Record<string, string>,
  cookie?: string,
): Promise<{ status: number; headers: Headers; body: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  })
  const text = await response.text()
  return { status: response.status, headers: response.headers, body: text }
}

function extractSessionCookie(headers: Headers): string | null {
  const setCookies = headers.getSetCookie()
  for (const sc of setCookies) {
    const match = /^(accessToken=[^;]+)/.exec(sc)
    if (match) return match[1]!
  }
  return null
}

async function planeJsonGet<T>(baseUrl: string, path: string, cookie: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: "application/json", Cookie: cookie },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Plane API GET ${path} failed: ${response.status}${text ? ` — ${text}` : ""}`)
  }
  return (await response.json()) as T
}

async function planeJsonPost<T>(baseUrl: string, path: string, payload: unknown, cookie: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Plane API POST ${path} failed: ${response.status}${text ? ` — ${text}` : ""}`)
  }
  return (await response.json()) as T
}
```

- [ ] **Step 2: Commit**

```bash
git add typescript/src/dev/plane-bootstrap.ts
git commit -m "feat(plane): add bootstrap HTTP helpers for form + JSON auth"
```

---

### Task 4: Implement the main ensurePlaneBootstrap function

**Files:**
- Modify: `typescript/src/dev/plane-bootstrap.ts`

- [ ] **Step 1: Implement the core bootstrap orchestration**

This is the main exported function. It's idempotent: checks saved state first, validates the saved API key still works, and only bootstraps if needed.

```typescript
export async function ensurePlaneBootstrap(
  baseUrl: string,
  stateDir: string,
): Promise<BootstrapResult> {
  // 1. Check for existing bootstrap state
  const existing = await readBootstrapState(stateDir)
  if (existing) {
    // Validate the saved API key still works
    const valid = await validateApiKey(baseUrl, existing.apiKey)
    if (valid) {
      process.stdout.write("Plane bootstrap: already configured\n")
      process.stdout.write(`- admin: ${existing.adminEmail}\n`)
      process.stdout.write(`- workspace: ${existing.workspaceSlug}\n`)
      process.stdout.write(`- project: ${existing.projectId}\n`)
      return existing
    }
    process.stdout.write("Plane bootstrap: saved API key is stale, re-bootstrapping\n")
  }

  process.stdout.write("Plane bootstrap: fresh instance detected, setting up\n")

  // 2. Create admin user (idempotent — if admin exists, just sign in)
  const cookie = await ensureAdminUser(baseUrl)

  // 3. Create workspace (idempotent — skip if exists)
  const workspace = await ensureWorkspace(baseUrl, cookie)

  // 4. Create project (idempotent — skip if exists)
  const project = await ensureProject(baseUrl, cookie, workspace.slug)

  // 5. Seed test issues (idempotent — skip if issues already exist)
  await ensureSeedIssues(baseUrl, cookie, workspace.slug, project.id)

  // 6. Create API token
  const apiToken = await ensureApiToken(baseUrl, cookie)

  const result: BootstrapResult = {
    apiKey: apiToken.token,
    workspaceSlug: workspace.slug,
    projectId: project.id,
    adminEmail: ADMIN_EMAIL,
    bootstrappedAt: new Date().toISOString(),
  }

  await writeBootstrapState(stateDir, result)
  process.stdout.write("Plane bootstrap: complete\n")
  process.stdout.write(`- admin: ${result.adminEmail}\n`)
  process.stdout.write(`- workspace: ${result.workspaceSlug}\n`)
  process.stdout.write(`- project: ${result.projectId}\n`)
  process.stdout.write(`- API key saved to ${stateDir}/${BOOTSTRAP_FILE}\n`)
  return result
}
```

- [ ] **Step 2: Commit**

```bash
git add typescript/src/dev/plane-bootstrap.ts
git commit -m "feat(plane): add ensurePlaneBootstrap orchestrator"
```

---

### Task 5: Implement the individual bootstrap steps

**Files:**
- Modify: `typescript/src/dev/plane-bootstrap.ts`

- [ ] **Step 1: Implement validateApiKey**

```typescript
async function validateApiKey(baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/users/me/`, {
      headers: { Accept: "application/json", "X-Api-Key": apiKey },
    })
    return response.ok
  } catch {
    return false
  }
}
```

- [ ] **Step 2: Implement ensureAdminUser**

```typescript
async function ensureAdminUser(baseUrl: string): Promise<string> {
  // Try signing in first (admin may already exist)
  const signInResult = await planeFormPost(baseUrl, "/auth/admins/sign-in/", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  })

  let cookie = extractSessionCookie(signInResult.headers)
  if (cookie) {
    process.stdout.write("Plane bootstrap: admin user exists, signed in\n")
    return cookie
  }

  // Admin doesn't exist — create via signup
  process.stdout.write("Plane bootstrap: creating admin user\n")
  const signUpResult = await planeFormPost(baseUrl, "/auth/admins/sign-up/", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    first_name: ADMIN_FIRST_NAME,
    last_name: ADMIN_LAST_NAME,
    company_name: COMPANY_NAME,
    is_telemetry_enabled: "false",
  })

  cookie = extractSessionCookie(signUpResult.headers)
  if (!cookie) {
    // The signup might redirect — try signing in now
    const retrySignIn = await planeFormPost(baseUrl, "/auth/admins/sign-in/", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    })
    cookie = extractSessionCookie(retrySignIn.headers)
  }

  if (!cookie) {
    throw new Error("Failed to create admin user or obtain session cookie")
  }

  process.stdout.write("Plane bootstrap: admin user created\n")
  return cookie
}
```

- [ ] **Step 3: Implement ensureWorkspace**

```typescript
async function ensureWorkspace(baseUrl: string, cookie: string): Promise<Workspace> {
  // Check if workspace already exists
  const existing = await planeJsonGet<ReadonlyArray<Workspace>>(baseUrl, "/api/workspaces/", cookie)
  const found = existing.find((w) => w.slug === WORKSPACE_SLUG)
  if (found) {
    process.stdout.write(`Plane bootstrap: workspace "${WORKSPACE_SLUG}" exists\n`)
    return found
  }

  process.stdout.write(`Plane bootstrap: creating workspace "${WORKSPACE_SLUG}"\n`)
  const workspace = await planeJsonPost<Workspace>(baseUrl, "/api/workspaces/", {
    name: WORKSPACE_NAME,
    slug: WORKSPACE_SLUG,
  }, cookie)
  return workspace
}
```

- [ ] **Step 4: Implement ensureProject**

```typescript
async function ensureProject(baseUrl: string, cookie: string, workspaceSlug: string): Promise<Project> {
  // Check if project already exists
  type ProjectList = { readonly results?: ReadonlyArray<Project> }
  const existing = await planeJsonGet<ProjectList>(
    baseUrl,
    `/api/workspaces/${workspaceSlug}/projects/`,
    cookie,
  )
  const found = (existing.results ?? []).find((p) => p.identifier === PROJECT_IDENTIFIER)
  if (found) {
    process.stdout.write(`Plane bootstrap: project "${PROJECT_IDENTIFIER}" exists\n`)
    return found
  }

  process.stdout.write(`Plane bootstrap: creating project "${PROJECT_IDENTIFIER}"\n`)
  const project = await planeJsonPost<Project>(
    baseUrl,
    `/api/workspaces/${workspaceSlug}/projects/`,
    {
      name: PROJECT_NAME,
      identifier: PROJECT_IDENTIFIER,
      description: "Symphony integration test project (auto-created by bootstrap)",
    },
    cookie,
  )
  return project
}
```

- [ ] **Step 5: Implement ensureSeedIssues**

```typescript
const SEED_ISSUES = [
  {
    name: "Create TEST_SYMPHONY.txt in repo root",
    description_html: "<p>Create a file named TEST_SYMPHONY.txt in the repository root containing: <code>hello from symphony</code></p>",
    targetState: "Todo",
  },
  {
    name: "Add a README section about local development",
    description_html: "<p>Add a 'Local Development' section to the project README explaining how to set up and run the project locally.</p>",
    targetState: "Todo",
  },
] as const

async function ensureSeedIssues(
  baseUrl: string,
  cookie: string,
  workspaceSlug: string,
  projectId: string,
): Promise<void> {
  // Get project states to find the "Todo" state UUID
  type StateList = { readonly results?: ReadonlyArray<State> }
  const statesResponse = await planeJsonGet<StateList>(
    baseUrl,
    `/api/workspaces/${workspaceSlug}/projects/${projectId}/states/`,
    cookie,
  )
  const states = statesResponse.results ?? []
  const todoState = states.find((s) => s.name === "Todo")
  if (!todoState) {
    process.stdout.write("Plane bootstrap: warning — no 'Todo' state found, skipping seed issues\n")
    return
  }

  // Check existing issues
  type IssueList = { readonly results?: ReadonlyArray<{ readonly name?: string }>, readonly total_results?: number }
  const existingIssues = await planeJsonGet<IssueList>(
    baseUrl,
    `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/work-items/?per_page=50`,
    cookie,
  )
  const existingNames = new Set((existingIssues.results ?? []).map((i) => i.name))

  for (const seed of SEED_ISSUES) {
    if (existingNames.has(seed.name)) {
      process.stdout.write(`Plane bootstrap: issue "${seed.name}" already exists\n`)
      continue
    }

    process.stdout.write(`Plane bootstrap: creating issue "${seed.name}"\n`)
    await planeJsonPost(
      baseUrl,
      `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/work-items/`,
      {
        name: seed.name,
        description_html: seed.description_html,
        state: todoState.id,
        priority: "medium",
      },
      cookie,
    )
  }
}
```

- [ ] **Step 6: Implement ensureApiToken**

```typescript
async function ensureApiToken(baseUrl: string, cookie: string): Promise<ApiToken> {
  // Check for existing token with our label
  const existing = await planeJsonGet<ReadonlyArray<{ id: string; label: string }>>(
    baseUrl,
    "/api/users/api-tokens/",
    cookie,
  )
  const found = existing.find((t) => t.label === API_TOKEN_LABEL)

  if (found) {
    // Can't retrieve the token value from an existing token — delete and recreate
    process.stdout.write("Plane bootstrap: rotating API token\n")
    await fetch(`${baseUrl}/api/users/api-tokens/${found.id}/`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })
  }

  process.stdout.write("Plane bootstrap: creating API token\n")
  const token = await planeJsonPost<ApiToken>(
    baseUrl,
    "/api/users/api-tokens/",
    { label: API_TOKEN_LABEL, description: "Auto-generated by Symphony bootstrap" },
    cookie,
  )
  return token
}
```

- [ ] **Step 7: Run typecheck**

Run: `cd /Users/Patrick.Hall/workspace/symphony/typescript && bun run typecheck`
Expected: PASS (zero errors)

- [ ] **Step 8: Commit**

```bash
git add typescript/src/dev/plane-bootstrap.ts
git commit -m "feat(plane): implement all bootstrap steps (admin, workspace, project, issues, token)"
```

---

### Task 6: Integrate bootstrap into plane.ts

**Files:**
- Modify: `typescript/src/dev/plane.ts`

- [ ] **Step 1: Add import at top of plane.ts**

At the top of the file, after existing imports:

```typescript
import { ensurePlaneBootstrap, readBootstrapState } from "./plane-bootstrap.js"
```

- [ ] **Step 2: Make PLANE_API_KEY, PLANE_WORKSPACE_SLUG, PLANE_PROJECT_ID optional in loadSettings**

Change `loadSettings()` to not call `requireEnv` for the three bootstrap-managed values. Instead, read them from env vars OR fall back to empty strings (to be filled by bootstrap).

Replace the three `requireEnv` calls in `loadSettings()` (around lines 118-120):

```typescript
// Before:
//   planeApiKey: requireEnv("PLANE_API_KEY"),
//   planeWorkspaceSlug: requireEnv("PLANE_WORKSPACE_SLUG"),
//   planeProjectId: requireEnv("PLANE_PROJECT_ID"),

// After:
    planeApiKey: process.env["PLANE_API_KEY"]?.trim() ?? "",
    planeWorkspaceSlug: process.env["PLANE_WORKSPACE_SLUG"]?.trim() ?? "",
    planeProjectId: process.env["PLANE_PROJECT_ID"]?.trim() ?? "",
```

- [ ] **Step 3: Add applyBootstrap helper function**

Add a new function after `loadSettings()`:

```typescript
function applyBootstrap(
  settings: Settings,
  bootstrap: { apiKey: string; workspaceSlug: string; projectId: string },
): Settings {
  return {
    ...settings,
    planeApiKey: settings.planeApiKey || bootstrap.apiKey,
    planeWorkspaceSlug: settings.planeWorkspaceSlug || bootstrap.workspaceSlug,
    planeProjectId: settings.planeProjectId || bootstrap.projectId,
  }
}
```

- [ ] **Step 4: Update ensureStackUp to call bootstrap and return settings**

Change the signature and body of `ensureStackUp`:

```typescript
async function ensureStackUp(settings: Settings): Promise<Settings> {
  await ensureStateDirs(settings)
  await checkLocalDependencies(settings)
  await ensurePlaneApi(settings)

  // Bootstrap Plane instance if needed (idempotent)
  const bootstrap = await ensurePlaneBootstrap(settings.planeBaseUrl, settings.stateDir)
  settings = applyBootstrap(settings, bootstrap)

  await ensurePlaneUiBuild(settings)
  await ensurePlaneUiServers(settings)
  await ensureOpencodeServer(settings)
  return settings
}
```

- [ ] **Step 5: Update callers of ensureStackUp in main()**

In the `main()` function, change `const settings = loadSettings()` to `let settings = loadSettings()`, and update every code path that calls `ensureStackUp` to capture the returned settings:

For the `"up"` command block:
```typescript
if (command === "up") {
  settings = await ensureStackUp(settings)
  await checkPlaneApi(settings)
  // ... rest unchanged
```

For the default path (check/workflow/run):
```typescript
settings = await ensureStackUp(settings)
await checkPlaneApi(settings)
// ... rest unchanged
```

- [ ] **Step 6: Update ensurePlaneApi health check to not require auth**

The current `ensurePlaneApi` waits for the API by hitting `/api/v1/users/me/` with `fetchJson` (which sends the API key). Before bootstrap, there's no API key. Change the health check to use the public instance endpoint:

Replace the `waitFor` check inside `ensurePlaneApi`:

```typescript
// Before:
await waitFor("Plane API auth", async () => {
  try {
    await fetchJson<{ id?: string }>(settings, "/api/v1/users/me/")
    return true
  } catch {
    return false
  }
}, 120_000, 1_000, ...)

// After:
await waitFor("Plane API", async () => {
  try {
    const response = await fetch(`${settings.planeBaseUrl}/api/instances/`)
    return response.ok
  } catch {
    return false
  }
}, 120_000, 1_000, ...)
```

- [ ] **Step 7: Run typecheck**

Run: `cd /Users/Patrick.Hall/workspace/symphony/typescript && bun run typecheck`
Expected: PASS

- [ ] **Step 8: Run all tests**

Run: `cd /Users/Patrick.Hall/workspace/symphony/typescript && bun run test`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add typescript/src/dev/plane.ts
git commit -m "feat(plane): integrate idempotent bootstrap into plane:up"
```

---

### Task 7: Add bootstrap test edge cases

**Files:**
- Modify: `typescript/src/dev/plane-bootstrap.test.ts`

- [ ] **Step 1: Add test for corrupted bootstrap file**

```typescript
test("readBootstrapState returns null for corrupted file", async () => {
  const { readBootstrapState } = await import("./plane-bootstrap.js")
  await writeFile(join(testDir, "bootstrap.json"), "not json", "utf8")
  const result = await readBootstrapState(testDir)
  expect(result).toBeNull()
})

test("readBootstrapState returns null for missing required fields", async () => {
  const { readBootstrapState } = await import("./plane-bootstrap.js")
  await writeFile(
    join(testDir, "bootstrap.json"),
    JSON.stringify({ version: 1, apiKey: "x" }),
    "utf8",
  )
  const result = await readBootstrapState(testDir)
  expect(result).toBeNull()
})
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/Patrick.Hall/workspace/symphony/typescript && bun run test -- src/dev/plane-bootstrap.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add typescript/src/dev/plane-bootstrap.test.ts
git commit -m "test(plane): add bootstrap state edge case tests"
```

---

### Task 8: Update PLANE_DEV.md docs

**Files:**
- Modify: `typescript/PLANE_DEV.md`

- [ ] **Step 1: Replace the Required env vars section and add Quick Start**

Replace the top sections of PLANE_DEV.md with:

```markdown
# Plane Local Dev Loop

Use this flow when iterating on the Symphony + Plane integration locally.

## Goal

Make the local Plane instance the tracker under test while Symphony runs with the OpenCode engine in a repeatable loop.

## Prerequisites

- Local Plane is cloned at `../../plane` (relative to `typescript/`) or at `$SYMPHONY_PLANE_REPO`
- `opencode` is installed and available in `PATH`
- `docker` is installed and running
- `pnpm` is installed
- Symphony dependencies installed with Bun

## Quick Start

```bash
# First time — brings up everything from zero (no env vars needed):
bun run plane:up

# Run Symphony against local Plane:
bun run plane:dev

# Clean stop:
bun run plane:down
```

On first run, `plane:up` will automatically:
1. Start Plane backend Docker containers
2. Create an admin user (`admin@symphony.local`)
3. Create a "Symphony" workspace and "SYM" project with default states
4. Seed test issues ("Create TEST_SYMPHONY.txt", "Add a README section")
5. Generate an API token
6. Save all credentials to `.plane-dev/bootstrap.json`

Subsequent runs skip bootstrap if the saved API key is still valid.

## Optional env var overrides

These take precedence over auto-bootstrapped values:

```bash
export PLANE_API_KEY="..."           # Override bootstrapped API key
export PLANE_WORKSPACE_SLUG="..."    # Override bootstrapped workspace
export PLANE_PROJECT_ID="..."        # Override bootstrapped project
```

Other optional env vars (same as before):

```bash
export PLANE_BASE_URL="http://localhost:8000"
export SYMPHONY_OBSERVABILITY_PORT="3010"
export SYMPHONY_WORKSPACE_ROOT="$HOME/code/symphony-plane-test-workspaces"
export SYMPHONY_PLANE_REPO="/path/to/plane"
export SYMPHONY_POLL_INTERVAL_MS="15000"
export SYMPHONY_OPENCODE_SERVER_HOST="127.0.0.1"
export SYMPHONY_OPENCODE_SERVER_PORT="4096"
export SYMPHONY_OPENCODE_AGENT="build"
export SYMPHONY_OPENCODE_MODEL="anthropic/claude-sonnet-4-20250514"
```
```

Keep the Commands, Suggested testing loop, and other sections below mostly as-is, but simplify the testing loop to remove the manual env var setup steps.

- [ ] **Step 2: Commit**

```bash
git add typescript/PLANE_DEV.md
git commit -m "docs: update PLANE_DEV.md for zero-config bootstrap"
```

---

### Task 9: Full verification

- [ ] **Step 1: Run typecheck**

Run: `cd /Users/Patrick.Hall/workspace/symphony/typescript && bun run typecheck`
Expected: PASS

- [ ] **Step 2: Run all tests**

Run: `cd /Users/Patrick.Hall/workspace/symphony/typescript && bun run test`
Expected: All tests pass

- [ ] **Step 3: Verify the full flow works (manual smoke test if Docker available)**

```bash
cd /Users/Patrick.Hall/workspace/symphony/typescript

# Clean slate
bun run plane:down

# Bring up from zero (should auto-bootstrap)
bun run plane:up

# Check that bootstrap.json was created
cat .plane-dev/bootstrap.json

# Verify Plane has issues
bun run plane:check

# Run again — should skip bootstrap ("already configured")
bun run plane:up
```

- [ ] **Step 4: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix(plane): address bootstrap smoke test findings"
```
