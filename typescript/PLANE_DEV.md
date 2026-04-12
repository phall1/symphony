# Plane Local Dev Loop

Use this flow when iterating on the Symphony + Plane integration locally.

## Goal

Make the local Plane instance the tracker under test while Symphony runs with the OpenCode engine in a repeatable loop.

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
4. Seed test issues
5. Generate an API token
6. Save all credentials to `.plane-dev/bootstrap.json`

Subsequent runs skip bootstrap if the saved API key is still valid.

## Prerequisites

- Local Plane is cloned at `/Users/Patrick.Hall/workspace/plane`
- Local Plane is running and reachable at `http://localhost:8000`
- `opencode` is installed and available in `PATH`
- Symphony dependencies installed with Bun

## Optional env var overrides

These take precedence over auto-bootstrapped values:

```bash
export PLANE_API_KEY="..."           # Override bootstrapped API key
export PLANE_WORKSPACE_SLUG="..."    # Override bootstrapped workspace
export PLANE_PROJECT_ID="..."        # Override bootstrapped project
export PLANE_BASE_URL="http://localhost:8000"
export SYMPHONY_OBSERVABILITY_PORT="3010"
export SYMPHONY_WORKSPACE_ROOT="$HOME/code/symphony-plane-test-workspaces"
export SYMPHONY_PLANE_REPO="/Users/Patrick.Hall/workspace/plane"
export SYMPHONY_POLL_INTERVAL_MS="15000"
export SYMPHONY_OPENCODE_SERVER_HOST="127.0.0.1"
export SYMPHONY_OPENCODE_SERVER_PORT="4096"
export SYMPHONY_OPENCODE_SERVER_URL="http://127.0.0.1:4096"
export SYMPHONY_OPENCODE_AGENT="build"
export SYMPHONY_OPENCODE_MODEL="anthropic/claude-sonnet-4-20250514"
```

## Commands

### 0. Clean stop

```bash
bun run plane:down
```

This stops:
- Symphony
- shared OpenCode server
- Plane web/admin UI servers
- Plane backend Docker services

### 1. Normal code verification

```bash
cd /Users/Patrick.Hall/workspace/symphony/typescript
bun run verify
```

### 2. Bring the local prerequisites up idempotently

```bash
bun run plane:up
```

This idempotently ensures:
- Plane backend Docker services are running
- Plane API is reachable
- Plane web/admin UI bundles exist
- Plane web UI is served on `http://127.0.0.1:3005`
- Plane admin UI is served on `http://127.0.0.1:3006/god-mode/`
- shared OpenCode server is reachable

### 3. Check local Plane connectivity and config

```bash
bun run plane:check
```

This validates:
- env vars are present
- local Plane repo path exists
- `opencode`, `docker`, and `pnpm` exist
- Plane API auth works
- Plane project lookup works
- work item listing works

### 4. Generate the local workflow file

```bash
bun run plane:workflow
```

This writes:

```text
WORKFLOW.plane.local.generated.md
```

### 5. Run the full local integration loop

```bash
bun run plane:dev
```

This will:
- idempotently bring the Plane/OpenCode prerequisites up
- run the Plane connectivity checks
- generate/refresh `WORKFLOW.plane.local.generated.md`
- start Symphony against local Plane in OpenCode shared-server mode
- expose observability on `http://127.0.0.1:${SYMPHONY_OBSERVABILITY_PORT:-3010}`

## Suggested testing loop

1. Reset to a clean local state:
   ```bash
   bun run plane:down
   ```
2. Make a code change in `typescript/`
3. Verify:
   ```bash
   bun run verify
   ```
4. Bring prerequisites up (auto-bootstraps on first run):
   ```bash
   bun run plane:up
   ```
5. Validate tracker connectivity:
   ```bash
   bun run plane:check
   ```
6. Run Symphony:
   ```bash
   bun run plane:dev
   ```
7. Observe:
   ```bash
   curl http://127.0.0.1:3010/api/v1/state
   ```
8. Inspect workspace output under:
   ```text
   ~/code/symphony-plane-test-workspaces
   ```

## Recommended smoke-test issue

Title:

```text
Create TEST_SYMPHONY.txt in repo root
```

Description:

```text
Create a file named TEST_SYMPHONY.txt in the repository root containing: hello from symphony
```

## Current scope of Plane support

Implemented:
- tracker polling
- issue selection by active states
- state refresh / reconciliation
- terminal-state lookup
- assignee `me` resolution
- blocker lookup through Plane relations
- OpenCode-based execution loop

Not yet generalized:
- agent-side tracker tools equivalent to the current Linear-specific helper path
- additional agent engines like Pi / Claude Code

## Next likely extensions

- add a generic tracker tool bridge for agents
- add more engines (`pi`, `claude-code`, etc.)
- add a deeper live E2E smoke test command once local Plane mutation flows are supported
