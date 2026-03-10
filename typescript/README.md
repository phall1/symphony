# Symphony TypeScript

TypeScript + Effect implementation of Symphony.

This runtime polls Linear for active issues, creates isolated per-issue workspaces, and runs coding agents (OpenCode or Codex).

## Quickstart (OpenCode default)

1. Install dependencies:

```bash
bun install
```

2. Make sure required tools exist:

```bash
command -v bun
command -v opencode
```

3. Export your Linear API key:

```bash
export LINEAR_API_KEY="lin_api_..."
```

4. Verify your workflow file exists (default is `./WORKFLOW.md`):

```bash
ls WORKFLOW.md
```

5. Run Symphony with observability enabled:

```bash
bun run src/cli/index.ts ./WORKFLOW.md --port 3000 --debug
```

6. Watch runtime state:

```bash
open http://127.0.0.1:3000/
curl http://127.0.0.1:3000/api/v1/state
```

## CLI Usage

```bash
symphony [workflow-path] [--port <n>] [--debug]
```

- `workflow-path`: path to `WORKFLOW.md` (default: `./WORKFLOW.md`)
- `--port <n>`: run HTTP observability server
- `--debug`: set `LOG_LEVEL=debug`

## Engine Configuration

Engine is selected in your `WORKFLOW.md` under `agent.engine`.

### OpenCode (recommended)

```yaml
agent:
  engine: opencode

opencode:
  mode: per-workspace
  agent: build
  model: anthropic/claude-sonnet-4-20250514
  # optional: fixed server port (default 0 = auto)
  # port: 0
```

Notes:
- `mode: per-workspace` makes Symphony spawn an OpenCode server per issue workspace.
- `mode: shared` uses one external OpenCode server (`opencode.server_url` required).
- If you use Oh-My-OpenCode (or any dotfile preset), set `opencode.agent` explicitly here to avoid inheriting an unexpected default agent.
- In per-workspace mode, `opencode.port: 0` is recommended for concurrent workers; non-zero binds a fixed port and can conflict if multiple issues run at once.

### Codex (optional fallback)

```yaml
agent:
  engine: codex

codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
```

## Workspace Paths

Per-issue repos are created under `workspace.root` from `WORKFLOW.md`.

With the included sample config, that is:

```text
~/code/symphony-workspaces/<ISSUE-ID>
```

Useful checks:

```bash
ls ~/code/symphony-workspaces
git -C ~/code/symphony-workspaces/PHA-7 status
git -C ~/code/symphony-workspaces/PHA-7 diff
```

## Troubleshooting

### "It runs, but nothing happens"

Check all of these first:

1. Linear auth present in current shell:

```bash
echo "$LINEAR_API_KEY" | wc -c
```

2. Workflow points to the right Linear project slug.
3. The project has issues in configured `active_states`.
4. `agent.engine` is set to the engine you actually installed.

Then inspect live state:

```bash
curl http://127.0.0.1:3000/api/v1/state
```

Interpretation:
- `running: 0` and `retrying: 0`: no dispatch candidates matched.
- `running > 0` with `session_id: null`: session startup is still in progress or blocked.
- Increasing token counts: agent is actively working.

### OpenCode-specific checks

```bash
command -v opencode
opencode --help >/dev/null
```

If using shared mode, verify server URL is reachable.

### Auto-reap behavior (per-workspace mode)

In per-workspace mode, Symphony tracks each spawned OpenCode server PID in the workspace at:

```text
<workspace>/.symphony-opencode-serve.pid
```

Before launching a new per-workspace server, Symphony will attempt to terminate the previously tracked PID for that same workspace (if it is still an `opencode serve` process). This prevents stale orphaned servers from accumulating after interrupted runs.

### Type safety check

```bash
bun run typecheck
```
