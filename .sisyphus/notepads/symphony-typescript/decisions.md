# Decisions — symphony-typescript

## Session ses_33f9c233fffeRkBJvbiSbCg9up — 2026-03-06

### Architecture Decisions
- TypeScript location: `typescript/` at repo root (sibling to `elixir/`)
- Runtime: Bun + TypeScript strict mode
- HTTP: Hono with loopback bind (127.0.0.1)
- CLI: plain process.argv (no @effect/cli)
- Default Codex sandbox: workspace-write + reject-based approval (matches Elixir)
- No dashboard HTML in Phase 1 — JSON API only
- No linear_graphql tool in Phase 1

### Dependency Versions (LOCKED)
- effect@4.0.0-beta.27
- @effect/platform-bun@4.0.0-beta.27
- @effect/vitest@4.0.0-beta.27
- liquidjs (latest)
- yaml (latest)
- chokidar (latest)
- hono (latest)
