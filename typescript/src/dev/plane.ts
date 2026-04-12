import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { constants, openSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { ensurePlaneBootstrap } from "./plane-bootstrap.js"

type PlaneProject = {
  readonly id?: string
  readonly identifier?: string
  readonly name?: string
}

type PlaneIssueList = {
  readonly results?: ReadonlyArray<{
    readonly id?: string
    readonly sequence_id?: string | number
    readonly name?: string
    readonly state?: string | { readonly name?: string }
  }>
  readonly total_results?: number
}

type PlaneStateList = {
  readonly results?: ReadonlyArray<{
    readonly id?: string
    readonly name?: string
  }>
}

type OpencodeHealth = {
  readonly healthy?: boolean
  readonly version?: string
}

type Settings = {
  readonly rootDir: string
  readonly stateDir: string
  readonly logDir: string
  readonly workflowPath: string
  readonly planeRepoPath: string
  readonly planeBaseUrl: string
  readonly planeApiKey: string
  readonly planeWorkspaceSlug: string
  readonly planeProjectId: string
  readonly observabilityPort: number
  readonly workspaceRoot: string
  readonly pollIntervalMs: number
  readonly planeWebPort: number
  readonly planeAdminPort: number
  readonly planeUiHost: string
  readonly planeUiBaseUrl: string
  readonly planeAdminBaseUrl: string
  readonly planeAdminUiUrl: string
  readonly opencodeServerHost: string
  readonly opencodeServerPort: number
  readonly opencodeServerUrl: string
  readonly opencodeAgent: string
  readonly opencodeModel: string
}

type Command = "check" | "workflow" | "run" | "up" | "down" | "status"

type BackgroundProcessSpec = {
  readonly name: string
  readonly pidFile: string
  readonly logFile: string
  readonly command: ReadonlyArray<string>
  readonly cwd: string
  readonly env?: Record<string, string>
  readonly match: string
}

const PID_FILES = {
  planeWebUi: "plane-web-ui.pid",
  planeAdminUi: "plane-admin-ui.pid",
  opencode: "opencode.pid",
} as const

function parseCommand(argv: string[]): Command {
  const command = (argv[2] ?? "check") as Command
  if (["check", "workflow", "run", "up", "down", "status"].includes(command)) {
    return command
  }

  process.stderr.write(`Unknown command: ${command}\n`)
  process.stderr.write("Usage: bun run src/dev/plane.ts [check|workflow|run|up|down|status]\n")
  process.exit(1)
}

function loadSettings(): Settings {
  const rootDir = process.cwd()
  const defaultPlaneRepoPath = resolve(rootDir, "../../plane")
  const planeUiHost = process.env["SYMPHONY_PLANE_UI_HOST"]?.trim() || "127.0.0.1"
  const planeWebPort = parseInt(process.env["SYMPHONY_PLANE_WEB_PORT"]?.trim() || "3005", 10)
  const planeAdminPort = parseInt(process.env["SYMPHONY_PLANE_ADMIN_PORT"]?.trim() || "3006", 10)
  const opencodeServerHost = process.env["SYMPHONY_OPENCODE_SERVER_HOST"]?.trim() || "127.0.0.1"
  const opencodeServerPort = parseInt(process.env["SYMPHONY_OPENCODE_SERVER_PORT"]?.trim() || "4096", 10)
  const explicitServerUrl = process.env["SYMPHONY_OPENCODE_SERVER_URL"]?.trim()
  const stateDir = resolve(rootDir, ".plane-dev")
  const logDir = join(stateDir, "logs")

  return {
    rootDir,
    stateDir,
    logDir,
    workflowPath: resolve(rootDir, "WORKFLOW.plane.local.generated.md"),
    planeRepoPath: resolve(process.env["SYMPHONY_PLANE_REPO"]?.trim() || defaultPlaneRepoPath),
    planeBaseUrl: (process.env["PLANE_BASE_URL"]?.trim() || "http://localhost:8000").replace(/\/+$/, ""),
    planeApiKey: process.env["PLANE_API_KEY"]?.trim() ?? "",
    planeWorkspaceSlug: process.env["PLANE_WORKSPACE_SLUG"]?.trim() ?? "",
    planeProjectId: process.env["PLANE_PROJECT_ID"]?.trim() ?? "",
    observabilityPort: parseInt(process.env["SYMPHONY_OBSERVABILITY_PORT"]?.trim() || "3010", 10),
    workspaceRoot: process.env["SYMPHONY_WORKSPACE_ROOT"]?.trim() || `${homedir()}/code/symphony-plane-test-workspaces`,
    pollIntervalMs: parseInt(process.env["SYMPHONY_POLL_INTERVAL_MS"]?.trim() || "15000", 10),
    planeUiHost,
    planeWebPort,
    planeAdminPort,
    planeUiBaseUrl: `http://${planeUiHost}:${planeWebPort}`,
    planeAdminBaseUrl: `http://${planeUiHost}:${planeAdminPort}`,
    planeAdminUiUrl: `http://${planeUiHost}:${planeAdminPort}/god-mode/`,
    opencodeServerHost,
    opencodeServerPort,
    opencodeServerUrl: (explicitServerUrl || `http://${opencodeServerHost}:${opencodeServerPort}`).replace(/\/+$/, ""),
    opencodeAgent: process.env["SYMPHONY_OPENCODE_AGENT"]?.trim() || "build",
    opencodeModel: process.env["SYMPHONY_OPENCODE_MODEL"]?.trim() || "anthropic/claude-sonnet-4-20250514",
  }
}

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

function pidFilePath(settings: Settings, fileName: string): string {
  return join(settings.stateDir, fileName)
}

function logFilePath(settings: Settings, fileName: string): string {
  return join(settings.logDir, fileName)
}

async function ensureStateDirs(settings: Settings): Promise<void> {
  await mkdir(settings.stateDir, { recursive: true })
  await mkdir(settings.logDir, { recursive: true })
}

async function assertPathExists(path: string, label: string): Promise<void> {
  try {
    await access(path, constants.F_OK)
  } catch {
    process.stderr.write(`${label} does not exist: ${path}\n`)
    process.exit(1)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function runCommand(
  command: ReadonlyArray<string>,
  cwd: string,
  env?: Record<string, string>,
): void {
  const proc = Bun.spawnSync([...command], {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdout: "inherit",
    stderr: "inherit",
  })

  if (proc.exitCode !== 0) {
    process.exit(proc.exitCode ?? 1)
  }
}

async function fetchJson<T>(settings: Settings, path: string): Promise<T> {
  const response = await fetch(`${settings.planeBaseUrl}${path}`, {
    headers: {
      Accept: "application/json",
      "X-Api-Key": settings.planeApiKey,
    },
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Plane API request failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`)
  }

  return await response.json() as T
}

async function fetchOpencodeHealth(settings: Settings): Promise<OpencodeHealth | null> {
  try {
    const response = await fetch(`${settings.opencodeServerUrl}/global/health`)
    if (!response.ok) return null
    return await response.json() as OpencodeHealth
  } catch {
    return null
  }
}

async function fetchUrlOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET" })
    return response.ok
  } catch {
    return false
  }
}

async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 60_000,
  intervalMs = 1_000,
  onTick?: (elapsedMs: number) => void,
): Promise<void> {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    onTick?.(Date.now() - startedAt)
    await Bun.sleep(intervalMs)
  }

  throw new Error(`Timed out waiting for ${label}`)
}

async function readTrackedPid(pidFile: string): Promise<number | null> {
  try {
    const raw = await readFile(pidFile, "utf8")
    const pid = parseInt(raw.trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

async function removePidFile(pidFile: string): Promise<void> {
  await rm(pidFile, { force: true }).catch(() => undefined)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function commandForPid(pid: number): string {
  const proc = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return new TextDecoder().decode(proc.stdout).trim()
}

async function stopTrackedProcess(pidFile: string, match: string): Promise<void> {
  const pid = await readTrackedPid(pidFile)
  if (!pid) return

  if (isProcessAlive(pid)) {
    const command = commandForPid(pid)
    if (command.includes(match)) {
      try {
        process.kill(-pid, "SIGTERM")
      } catch {
        try {
          process.kill(pid, "SIGTERM")
        } catch {
          // ignore
        }
      }

      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) break
        await Bun.sleep(250)
      }

      if (isProcessAlive(pid)) {
        try {
          process.kill(-pid, "SIGKILL")
        } catch {
          try {
            process.kill(pid, "SIGKILL")
          } catch {
            // ignore
          }
        }
      }
    }
  }

  await removePidFile(pidFile)
}

async function startDetachedProcess(spec: BackgroundProcessSpec): Promise<void> {
  await stopTrackedProcess(spec.pidFile, spec.match)

  const stdout = openSync(spec.logFile, "a")
  const stderr = openSync(spec.logFile, "a")

  const child = spawn(spec.command[0]!, spec.command.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
    detached: true,
    stdio: ["ignore", stdout, stderr],
  })

  child.unref()
  await writeFile(spec.pidFile, `${child.pid}\n`, "utf8")
}

async function ensurePlaneApiEnv(settings: Settings): Promise<void> {
  const envPath = resolve(settings.planeRepoPath, "apps/api/.env")
  const raw = await readFile(envPath, "utf8")

  const requiredOrigins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://localhost:3100",
    settings.planeUiBaseUrl,
    settings.planeAdminBaseUrl,
  ]

  const lines = raw.split(/\r?\n/)
  const nextLines = lines.map((line) => {
    if (line.startsWith("CORS_ALLOWED_ORIGINS=")) {
      const current = line.slice("CORS_ALLOWED_ORIGINS=".length).trim().replace(/^"|"$/g, "")
      const merged = Array.from(new Set([...current.split(",").map((part) => part.trim()).filter(Boolean), ...requiredOrigins]))
      return `CORS_ALLOWED_ORIGINS="${merged.join(",")}"`
    }

    if (line.startsWith("API_KEY_RATE_LIMIT=")) {
      return 'API_KEY_RATE_LIMIT="10000/minute"'
    }

    return line
  })

  const updated = nextLines.join("\n")
  if (updated !== raw) {
    await writeFile(envPath, updated, "utf8")
  }
}

async function checkLocalDependencies(settings: Settings): Promise<void> {
  await assertPathExists(settings.planeRepoPath, "Plane repo path")

  if (!Bun.which("opencode")) {
    process.stderr.write("Missing required command: opencode\n")
    process.exit(1)
  }

  if (!Bun.which("docker")) {
    process.stderr.write("Missing required command: docker\n")
    process.exit(1)
  }

  if (!Bun.which("pnpm")) {
    process.stderr.write("Missing required command: pnpm\n")
    process.exit(1)
  }
}

async function ensurePlaneApi(settings: Settings): Promise<void> {
  await ensurePlaneApiEnv(settings)
  process.stdout.write("Ensuring Plane backend containers are up\n")
  runCommand(["docker", "compose", "-f", "docker-compose-local.yml", "up", "-d"], settings.planeRepoPath)

  process.stdout.write("Waiting for Plane API to come up")
  let lastPrintedSecond = -1
  await waitFor("Plane API", async () => {
    try {
      const response = await fetch(`${settings.planeBaseUrl}/api/instances/`)
      return response.ok
    } catch {
      return false
    }
  }, 120_000, 1_000, (elapsedMs) => {
    const second = Math.floor(elapsedMs / 1000)
    if (second !== lastPrintedSecond) {
      process.stdout.write(".")
      lastPrintedSecond = second
    }
  })
  process.stdout.write(" done\n")

  process.stdout.write(`Plane API OK\n`)
  process.stdout.write(`- base URL: ${settings.planeBaseUrl}\n`)
}

function uiBuildStampPath(settings: Settings): string {
  return join(settings.stateDir, "plane-ui-build.json")
}

async function ensurePlaneUiBuild(settings: Settings): Promise<void> {
  const webIndex = resolve(settings.planeRepoPath, "apps/web/build/client/index.html")
  const adminIndex = resolve(settings.planeRepoPath, "apps/admin/build/client/index.html")
  const nextStamp = JSON.stringify({
    api: settings.planeBaseUrl,
    web: settings.planeUiBaseUrl,
    admin: settings.planeAdminBaseUrl,
  }, null, 2)

  const previousStamp = await readFile(uiBuildStampPath(settings), "utf8").catch(() => "")
  const needsBuild = !(await pathExists(webIndex)) || !(await pathExists(adminIndex)) || previousStamp !== nextStamp

  if (!needsBuild) {
    process.stdout.write("Plane UI build OK\n")
    process.stdout.write(`- web bundle: ${webIndex}\n`)
    process.stdout.write(`- admin bundle: ${adminIndex}\n`)
    return
  }

  process.stdout.write("Building Plane UI bundles\n")
  runCommand(
    ["pnpm", "turbo", "run", "build", "--filter=web", "--filter=admin"],
    settings.planeRepoPath,
    {
      VITE_API_BASE_URL: settings.planeBaseUrl,
      VITE_WEB_BASE_URL: settings.planeUiBaseUrl,
      VITE_ADMIN_BASE_URL: settings.planeAdminBaseUrl,
      VITE_ADMIN_BASE_PATH: "/god-mode",
    },
  )

  await writeFile(uiBuildStampPath(settings), nextStamp, "utf8")
}

async function ensurePlaneUiServers(settings: Settings): Promise<void> {
  const webPidFile = pidFilePath(settings, PID_FILES.planeWebUi)
  const adminPidFile = pidFilePath(settings, PID_FILES.planeAdminUi)
  const webLog = logFilePath(settings, "plane-web-ui.log")
  const adminLog = logFilePath(settings, "plane-admin-ui.log")
  const webRoot = resolve(settings.planeRepoPath, "apps/web/build/client")
  const adminRoot = resolve(settings.planeRepoPath, "apps/admin/build/client")

  if (!(await fetchUrlOk(settings.planeUiBaseUrl))) {
    process.stdout.write("Starting Plane web UI\n")
    await startDetachedProcess({
      name: "plane-web-ui",
      pidFile: webPidFile,
      logFile: webLog,
      command: ["bun", "run", "src/dev/plane-ui-server.ts", webRoot, String(settings.planeWebPort), settings.planeUiHost, "plane-web-ui", "/"],
      cwd: settings.rootDir,
      match: "plane-ui-server.ts",
    })
  }

  if (!(await fetchUrlOk(settings.planeAdminUiUrl))) {
    process.stdout.write("Starting Plane admin UI\n")
    await startDetachedProcess({
      name: "plane-admin-ui",
      pidFile: adminPidFile,
      logFile: adminLog,
      command: ["bun", "run", "src/dev/plane-ui-server.ts", adminRoot, String(settings.planeAdminPort), settings.planeUiHost, "plane-admin-ui", "/god-mode"],
      cwd: settings.rootDir,
      match: "plane-ui-server.ts",
    })
  }

  await waitFor("Plane web UI", () => fetchUrlOk(settings.planeUiBaseUrl))
  await waitFor("Plane admin UI", () => fetchUrlOk(settings.planeAdminUiUrl))

  process.stdout.write("Plane UI OK\n")
  process.stdout.write(`- web: ${settings.planeUiBaseUrl}\n`)
  process.stdout.write(`- admin: ${settings.planeAdminUiUrl}\n`)
}

async function ensureOpencodeServer(settings: Settings): Promise<void> {
  const existing = await fetchOpencodeHealth(settings)
  if (existing?.healthy) {
    process.stdout.write("OpenCode server OK\n")
    process.stdout.write(`- server URL: ${settings.opencodeServerUrl}\n`)
    process.stdout.write(`- version: ${existing.version ?? "unknown"}\n`)
    return
  }

  process.stdout.write("Starting OpenCode shared server\n")
  const pidFile = pidFilePath(settings, PID_FILES.opencode)
  const logFile = logFilePath(settings, "opencode.log")
  await startDetachedProcess({
    name: "opencode",
    pidFile,
    logFile,
    command: ["opencode", "serve", "--hostname", settings.opencodeServerHost, "--port", String(settings.opencodeServerPort)],
    cwd: settings.rootDir,
    match: "opencode serve",
  })

  await waitFor("OpenCode server", async () => {
    const health = await fetchOpencodeHealth(settings)
    return health?.healthy === true
  }, 30_000, 500)

  const health = await fetchOpencodeHealth(settings)
  process.stdout.write("OpenCode server OK\n")
  process.stdout.write(`- server URL: ${settings.opencodeServerUrl}\n`)
  process.stdout.write(`- version: ${health?.version ?? "unknown"}\n`)
}

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

async function checkPlaneApi(settings: Settings): Promise<{ projectIdentifier: string }> {
  const viewer = await fetchJson<{ id?: string; email?: string }>(settings, "/api/v1/users/me/")
  const project = await fetchJson<PlaneProject>(
    settings,
    `/api/v1/workspaces/${settings.planeWorkspaceSlug}/projects/${settings.planeProjectId}/`,
  )
  const issues = await fetchJson<PlaneIssueList>(
    settings,
    `/api/v1/workspaces/${settings.planeWorkspaceSlug}/projects/${settings.planeProjectId}/work-items/?expand=assignees,labels&per_page=50`,
  )
  const states = await fetchJson<PlaneStateList>(
    settings,
    `/api/v1/workspaces/${settings.planeWorkspaceSlug}/projects/${settings.planeProjectId}/states/?per_page=50`,
  )

  const stateMap = new Map((states.results ?? []).map((state) => [state.id ?? "", state.name ?? "unknown"]))
  const projectIdentifier = project.identifier?.trim() || settings.planeProjectId
  const sampleIssues = (issues.results ?? []).slice(0, 3).map((issue) => {
    const sequence = issue.sequence_id ?? issue.id ?? "unknown"
    const title = issue.name ?? "(untitled)"
    const state = typeof issue.state === "string"
      ? (stateMap.get(issue.state) ?? "unknown")
      : (issue.state?.name ?? "unknown")
    return `- ${projectIdentifier}-${sequence}: ${title} [${state}]`
  })

  process.stdout.write("Plane project OK\n")
  process.stdout.write(`- workspace: ${settings.planeWorkspaceSlug}\n`)
  process.stdout.write(`- project: ${project.name ?? settings.planeProjectId} (${projectIdentifier})\n`)
  process.stdout.write(`- viewer: ${viewer.email ?? viewer.id ?? "unknown"}\n`)
  process.stdout.write(`- visible issues: ${issues.total_results ?? issues.results?.length ?? 0}\n`)
  if (sampleIssues.length > 0) {
    process.stdout.write(`${sampleIssues.join("\n")}\n`)
  }

  return { projectIdentifier }
}

function buildWorkflow(settings: Settings): string {
  return `---
tracker:
  kind: plane
  endpoint: ${settings.planeBaseUrl}
  api_key: $PLANE_API_KEY
  workspace_slug: $PLANE_WORKSPACE_SLUG
  project_id: $PLANE_PROJECT_ID
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Canceled
    - Cancelled
    - Closed

polling:
  interval_ms: ${settings.pollIntervalMs}

workspace:
  root: ${settings.workspaceRoot}

hooks:
  after_create: |
    git clone --depth 1 ${settings.planeRepoPath} .
  before_remove: |
    true

agent:
  engine: opencode
  max_concurrent_agents: 1
  max_turns: 2

opencode:
  mode: shared
  server_url: ${settings.opencodeServerUrl}
  agent: ${settings.opencodeAgent}
  model: ${settings.opencodeModel}

codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
---

You are working on a Plane ticket.

Ticket details:
- Identifier: {{ issue.identifier }}
- Title: {{ issue.title }}
- State: {{ issue.state }}
- Description:
{% if issue.description %}{{ issue.description }}{% else %}(no description provided){% endif %}

This is a local Symphony integration/dev test against a self-hosted Plane instance.

Important:
- This task came from Plane, not Linear.
- Do not search Linear for the ticket.
- Work only in the provided repository copy.

Execution rules:
- Start from the ticket title and description above.
- Make the smallest correct change needed.
- Run targeted validation for the change.
- In the final response, report:
  - what changed
  - what was validated
  - any blockers
- Do not ask a human to do follow-up work unless blocked by missing auth, missing tools, or missing secrets.
`
}

async function writeWorkflow(settings: Settings): Promise<void> {
  const content = buildWorkflow(settings)
  await writeFile(settings.workflowPath, content, "utf8")
  process.stdout.write(`Wrote ${settings.workflowPath}\n`)
}

async function printStatus(settings: Settings): Promise<void> {
  const opencode = await fetchOpencodeHealth(settings)
  const planeApiOk = await (async () => {
    try {
      await fetchJson(settings, "/api/v1/users/me/")
      return true
    } catch {
      return false
    }
  })()
  const planeWebOk = await fetchUrlOk(settings.planeUiBaseUrl)
  const planeAdminOk = await fetchUrlOk(settings.planeAdminUiUrl)
  const symphonyOk = await fetchUrlOk(`http://127.0.0.1:${settings.observabilityPort}/api/v1/state`)

  process.stdout.write("Local Plane/Symphony status\n")
  process.stdout.write(`- Plane API: ${planeApiOk ? "up" : "down"} (${settings.planeBaseUrl})\n`)
  process.stdout.write(`- Plane web UI: ${planeWebOk ? "up" : "down"} (${settings.planeUiBaseUrl})\n`)
  process.stdout.write(`- Plane admin UI: ${planeAdminOk ? "up" : "down"} (${settings.planeAdminUiUrl})\n`)
  process.stdout.write(`- OpenCode: ${opencode?.healthy ? `up (${settings.opencodeServerUrl})` : "down"}\n`)
  process.stdout.write(`- Symphony: ${symphonyOk ? `up (http://127.0.0.1:${settings.observabilityPort}/)` : "down"}\n`)
}

async function stopAll(settings: Settings): Promise<void> {
  process.stdout.write("Stopping Symphony / OpenCode / Plane UI processes\n")
  runCommand(
    [
      "bash",
      "-lc",
      [
        `pkill -f 'src/cli/index.ts .*WORKFLOW.plane.local.generated' || true`,
        `pkill -f 'bun run plane:dev' || true`,
      ].join("; "),
    ],
    settings.rootDir,
  )

  await stopTrackedProcess(pidFilePath(settings, PID_FILES.planeWebUi), "plane-ui-server.ts")
  await stopTrackedProcess(pidFilePath(settings, PID_FILES.planeAdminUi), "plane-ui-server.ts")
  await stopTrackedProcess(pidFilePath(settings, PID_FILES.opencode), "opencode serve")

  process.stdout.write("Stopping Plane backend containers\n")
  runCommand(["docker", "compose", "-f", "docker-compose-local.yml", "down", "--remove-orphans"], settings.planeRepoPath)
}

async function runSymphony(settings: Settings): Promise<void> {
  process.stdout.write(`Starting Symphony with workflow ${settings.workflowPath}\n`)
  process.stdout.write(`Observability: http://127.0.0.1:${settings.observabilityPort}/\n`)

  const proc = Bun.spawn({
    cmd: [
      "bun",
      "run",
      "src/cli/index.ts",
      settings.workflowPath,
      "--port",
      String(settings.observabilityPort),
      "--debug",
    ],
    cwd: settings.rootDir,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })

  const exitCode = await proc.exited
  process.exit(exitCode)
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv)
  let settings = loadSettings()

  if (command === "down") {
    await ensureStateDirs(settings)
    await stopAll(settings)
    process.stdout.write("Plane/Symphony local stack stopped.\n")
    return
  }

  if (command === "status") {
    await ensureStateDirs(settings)
    await printStatus(settings)
    return
  }

  if (command === "up") {
    settings = await ensureStackUp(settings)
    await checkPlaneApi(settings)
    process.stdout.write("Plane/Symphony local prerequisites are ready.\n")
    process.stdout.write(`- Plane web UI: ${settings.planeUiBaseUrl}\n`)
    process.stdout.write(`- Plane admin UI: ${settings.planeAdminUiUrl}\n`)
    process.stdout.write(`- Plane API: ${settings.planeBaseUrl}\n`)
    process.stdout.write(`- OpenCode: ${settings.opencodeServerUrl}\n`)
    return
  }

  settings = await ensureStackUp(settings)
  await checkPlaneApi(settings)

  if (command === "check") {
    process.stdout.write("Plane dev check complete.\n")
    return
  }

  await writeWorkflow(settings)

  if (command === "workflow") {
    process.stdout.write("Workflow generation complete.\n")
    return
  }

  await runSymphony(settings)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
