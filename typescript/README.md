# Symphony TypeScript

TypeScript+Effect implementation of Symphony — an AI coding agent orchestrator that polls Linear, creates isolated per-issue workspaces, and runs coding agent sessions.

## Setup

```bash
bun install
bun run symphony WORKFLOW.md
```

## Options

```
symphony [path-to-WORKFLOW.md] [--port <n>]
```

- `path-to-WORKFLOW.md`: defaults to `./WORKFLOW.md`
- `--port <n>`: enable HTTP observability server on port n
```
