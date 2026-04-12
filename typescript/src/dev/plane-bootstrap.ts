import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BootstrapResult = {
  readonly apiKey: string
  readonly workspaceSlug: string
  readonly projectId: string
  readonly adminEmail: string
}

type ApiTokenEntry = {
  readonly id?: string
  readonly label?: string
  readonly token?: string
}

type WorkspaceEntry = {
  readonly id?: string
  readonly slug?: string
  readonly name?: string
}

type ProjectEntry = {
  readonly id?: string
  readonly identifier?: string
  readonly name?: string
}

type StateEntry = {
  readonly id?: string
  readonly name?: string
  readonly group?: string
}

type IssueEntry = {
  readonly id?: string
  readonly name?: string
  readonly state?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

const SEED_ISSUES: ReadonlyArray<{ readonly name: string; readonly stateName: string }> = [
  { name: "Create TEST_SYMPHONY.txt in repo root", stateName: "Todo" },
  { name: "Add a README section about local development", stateName: "Todo" },
]

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

export function readBootstrapState(stateDir: string): BootstrapResult | null {
  try {
    const raw = require("node:fs").readFileSync(join(stateDir, BOOTSTRAP_FILE), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)["apiKey"] === "string" &&
      typeof (parsed as Record<string, unknown>)["workspaceSlug"] === "string" &&
      typeof (parsed as Record<string, unknown>)["projectId"] === "string" &&
      typeof (parsed as Record<string, unknown>)["adminEmail"] === "string"
    ) {
      return parsed as BootstrapResult
    }
    return null
  } catch {
    return null
  }
}

export async function writeBootstrapState(stateDir: string, result: BootstrapResult): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(stateDir, BOOTSTRAP_FILE), JSON.stringify(result, null, 2) + "\n", "utf8")
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * POST form-urlencoded data (for admin sign-up / sign-in).
 * Plane's auth endpoints return a 302 redirect with Set-Cookie.
 * We disable redirect following so we can capture the cookie.
 */
async function planeFormPost(
  baseUrl: string,
  path: string,
  body: Record<string, string>,
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  })
  return response
}

/**
 * Extract the `accessToken` value from Set-Cookie headers.
 */
function extractSessionCookie(response: Response): string | null {
  const setCookieHeaders = response.headers.getSetCookie?.() ?? []
  for (const header of setCookieHeaders) {
    const match = header.match(/accessToken=([^;]+)/)
    if (match?.[1]) {
      return match[1]
    }
  }
  // Fallback: check raw set-cookie header
  const raw = response.headers.get("set-cookie")
  if (raw) {
    const match = raw.match(/accessToken=([^;]+)/)
    if (match?.[1]) {
      return match[1]
    }
  }
  return null
}

async function planeJsonGet<T>(baseUrl: string, path: string, cookie: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Cookie: `accessToken=${cookie}`,
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Plane GET ${path} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`)
  }
  return (await response.json()) as T
}

async function planeJsonPost<T>(baseUrl: string, path: string, cookie: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: `accessToken=${cookie}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Plane POST ${path} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`)
  }
  return (await response.json()) as T
}

async function planeJsonDelete(baseUrl: string, path: string, cookie: string): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      Cookie: `accessToken=${cookie}`,
    },
  })
  if (!response.ok && response.status !== 204) {
    const text = await response.text().catch(() => "")
    throw new Error(`Plane DELETE ${path} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`)
  }
}

// ---------------------------------------------------------------------------
// Individual bootstrap steps
// ---------------------------------------------------------------------------

/**
 * Validate that an API key is still working against the Plane instance.
 */
async function validateApiKey(baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/users/me/`, {
      method: "GET",
      headers: { "X-Api-Key": apiKey },
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Ensure the admin user exists. Try sign-in first, fall back to sign-up.
 * Returns the session cookie value.
 */
async function ensureAdminUser(baseUrl: string): Promise<string> {
  // Try sign-in first
  const signInResponse = await planeFormPost(baseUrl, "/auth/admins/sign-in/", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  })
  const signInCookie = extractSessionCookie(signInResponse)
  if (signInCookie) {
    return signInCookie
  }

  // Fall back to sign-up
  const signUpResponse = await planeFormPost(baseUrl, "/auth/admins/sign-up/", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    first_name: ADMIN_FIRST_NAME,
    last_name: ADMIN_LAST_NAME,
    company_name: COMPANY_NAME,
  })
  const signUpCookie = extractSessionCookie(signUpResponse)
  if (signUpCookie) {
    return signUpCookie
  }

  throw new Error(
    `Failed to authenticate admin user. Sign-in status: ${signInResponse.status}, Sign-up status: ${signUpResponse.status}`,
  )
}

/**
 * Ensure the "symphony" workspace exists. Returns the workspace slug.
 */
async function ensureWorkspace(baseUrl: string, cookie: string): Promise<string> {
  const workspaces = await planeJsonGet<ReadonlyArray<WorkspaceEntry>>(baseUrl, "/api/workspaces/", cookie)
  const existing = workspaces.find((ws) => ws.slug === WORKSPACE_SLUG)
  if (existing) {
    return existing.slug ?? WORKSPACE_SLUG
  }

  const created = await planeJsonPost<WorkspaceEntry>(baseUrl, "/api/workspaces/", cookie, {
    name: WORKSPACE_NAME,
    slug: WORKSPACE_SLUG,
  })
  return created.slug ?? WORKSPACE_SLUG
}

/**
 * Ensure the "SYM" project exists in the workspace. Returns the project ID.
 */
async function ensureProject(baseUrl: string, cookie: string, workspaceSlug: string): Promise<string> {
  const projectList = await planeJsonGet<{ results?: ReadonlyArray<ProjectEntry> }>(
    baseUrl,
    `/api/workspaces/${workspaceSlug}/projects/`,
    cookie,
  )
  const existing = (projectList.results ?? []).find((p) => p.identifier === PROJECT_IDENTIFIER)
  if (existing?.id) {
    return existing.id
  }

  const created = await planeJsonPost<ProjectEntry>(
    baseUrl,
    `/api/workspaces/${workspaceSlug}/projects/`,
    cookie,
    {
      name: PROJECT_NAME,
      identifier: PROJECT_IDENTIFIER,
      network: 2, // secret
    },
  )
  if (!created.id) {
    throw new Error("Failed to create project — no ID returned")
  }
  return created.id
}

/**
 * Ensure seed issues exist in the project.
 * Fetches states to resolve the "Todo" UUID, checks existing issues by name,
 * and creates only those that are missing.
 */
async function ensureSeedIssues(
  baseUrl: string,
  cookie: string,
  workspaceSlug: string,
  projectId: string,
): Promise<void> {
  // Fetch project states to find the "Todo" state UUID
  const stateList = await planeJsonGet<{ results?: ReadonlyArray<StateEntry> }>(
    baseUrl,
    `/api/workspaces/${workspaceSlug}/projects/${projectId}/states/`,
    cookie,
  )
  const states = stateList.results ?? []
  const todoState = states.find((s) => s.name === "Todo")
  if (!todoState?.id) {
    throw new Error(`Could not find "Todo" state in project ${projectId}. Available: ${states.map((s) => s.name).join(", ")}`)
  }

  // Fetch existing issues
  const issueList = await planeJsonGet<{ results?: ReadonlyArray<IssueEntry> }>(
    baseUrl,
    `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/work-items/`,
    cookie,
  )
  const existingNames = new Set((issueList.results ?? []).map((issue) => issue.name))

  // Create missing seed issues
  for (const seed of SEED_ISSUES) {
    if (existingNames.has(seed.name)) {
      continue
    }
    await planeJsonPost(
      baseUrl,
      `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/work-items/`,
      cookie,
      {
        name: seed.name,
        state: todoState.id,
      },
    )
  }
}

/**
 * Ensure an API token labelled "symphony-dev" exists.
 * Since we can't retrieve the token value after creation,
 * we delete any existing one and create a fresh one.
 * Returns the token string.
 */
async function ensureApiToken(baseUrl: string, cookie: string): Promise<string> {
  const tokens = await planeJsonGet<ReadonlyArray<ApiTokenEntry>>(baseUrl, "/api/users/api-tokens/", cookie)

  // Delete existing symphony-dev token if found (can't retrieve its value)
  const existing = tokens.find((t) => t.label === API_TOKEN_LABEL)
  if (existing?.id) {
    await planeJsonDelete(baseUrl, `/api/users/api-tokens/${existing.id}/`, cookie)
  }

  // Create a new token
  const created = await planeJsonPost<ApiTokenEntry>(baseUrl, "/api/users/api-tokens/", cookie, {
    label: API_TOKEN_LABEL,
  })
  if (!created.token) {
    throw new Error("Failed to create API token — no token value returned")
  }
  return created.token
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Idempotent entry point: bootstrap a fresh local Plane instance.
 *
 * 1. Reads existing bootstrap.json, validates API key still works -> returns early if valid
 * 2. Otherwise: creates admin -> workspace -> project -> seed issues -> API token -> saves state
 */
export async function ensurePlaneBootstrap(baseUrl: string, stateDir: string): Promise<BootstrapResult> {
  // Check for existing valid state
  const cached = readBootstrapState(stateDir)
  if (cached) {
    const valid = await validateApiKey(baseUrl, cached.apiKey)
    if (valid) {
      process.stdout.write("Plane bootstrap: existing API key is valid, skipping bootstrap\n")
      return cached
    }
    process.stdout.write("Plane bootstrap: existing API key is invalid, re-bootstrapping\n")
  }

  process.stdout.write("Plane bootstrap: creating admin user\n")
  const cookie = await ensureAdminUser(baseUrl)

  process.stdout.write("Plane bootstrap: ensuring workspace\n")
  const workspaceSlug = await ensureWorkspace(baseUrl, cookie)

  process.stdout.write("Plane bootstrap: ensuring project\n")
  const projectId = await ensureProject(baseUrl, cookie, workspaceSlug)

  process.stdout.write("Plane bootstrap: seeding issues\n")
  await ensureSeedIssues(baseUrl, cookie, workspaceSlug, projectId)

  process.stdout.write("Plane bootstrap: creating API token\n")
  const apiKey = await ensureApiToken(baseUrl, cookie)

  const result: BootstrapResult = {
    apiKey,
    workspaceSlug,
    projectId,
    adminEmail: ADMIN_EMAIL,
  }

  await writeBootstrapState(stateDir, result)
  process.stdout.write("Plane bootstrap: complete\n")

  return result
}
