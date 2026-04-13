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

type PaginatedResults<T> = {
  readonly results?: ReadonlyArray<T>
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
  readonly state?: string | { readonly id?: string; readonly name?: string }
}

type CsrfTokenResponse = {
  readonly csrf_token?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOOTSTRAP_FILE = "bootstrap.json"

const ADMIN_EMAIL = "admin@symphony.local"
const ADMIN_PASSWORD = process.env["SYMPHONY_PLANE_ADMIN_PASSWORD"]?.trim() || "Symphony!Dev2026#"
const ADMIN_FIRST_NAME = "Symphony"
const ADMIN_LAST_NAME = "Admin"
const COMPANY_NAME = "Symphony Dev"

const WORKSPACE_NAME = "Symphony"
const WORKSPACE_SLUG = "symphony"

const PROJECT_NAME = "Symphony Test"
const PROJECT_IDENTIFIER = "SYM"

const API_TOKEN_LABEL = "symphony-dev"

type SeedIssue = {
  readonly name: string
  readonly stateName: string
  readonly descriptionHtml: string
}

const SEED_ISSUES: ReadonlyArray<SeedIssue> = [
  {
    name: "Create PLANE_LIVE_SMOKE.txt in repo root",
    stateName: "In Progress",
    descriptionHtml:
      "<p>Create a file named <code>PLANE_LIVE_SMOKE.txt</code> in the repository root containing exactly <code>plane live smoke ok</code>.</p>",
  },
  {
    name: "Add a README section about local development",
    stateName: "Todo",
    descriptionHtml:
      "<p>Add a short Local Development section to the repository README with one setup command and one verification command.</p>",
  },
]

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

export async function readBootstrapState(stateDir: string): Promise<BootstrapResult | null> {
  try {
    const raw = await readFile(join(stateDir, BOOTSTRAP_FILE), "utf8")
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
//
// Plane exposes two API surfaces:
//   - Internal API (`/api/...`): uses session cookie auth. Used here for
//     workspace/project management and admin operations.
//   - Public API (`/api/v1/...`): uses API-key auth (`X-Api-Key` header).
//     Used for work-item (issue) operations and by the Symphony runtime.
//

/**
 * POST form-urlencoded data (for admin sign-up / sign-in).
 * Plane's instance admin auth endpoints return a 302 redirect with Set-Cookie.
 * We disable redirect following so we can capture the cookie.
 */
async function fetchCsrfSession(baseUrl: string): Promise<{ csrfToken: string; csrfCookie: string }> {
  const response = await fetch(`${baseUrl}/auth/get-csrf-token/`, {
    method: "GET",
    headers: { Accept: "application/json" },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch CSRF token: ${response.status} ${response.statusText}`)
  }

  const payload = (await response.json()) as CsrfTokenResponse
  const csrfToken = payload.csrf_token?.trim()
  if (!csrfToken) {
    throw new Error("Failed to fetch CSRF token: response did not include csrf_token")
  }

  const csrfCookie = extractCookieValue(response, "csrftoken")
  if (!csrfCookie) {
    throw new Error("Failed to fetch CSRF token: response did not set csrftoken cookie")
  }

  return { csrfToken, csrfCookie }
}

async function planeFormPost(
  baseUrl: string,
  path: string,
  body: Record<string, string>,
): Promise<Response> {
  const { csrfToken, csrfCookie } = await fetchCsrfSession(baseUrl)
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `csrftoken=${csrfCookie}`,
      Referer: `${baseUrl}${path}`,
    },
    body: new URLSearchParams({
      ...body,
      csrfmiddlewaretoken: csrfToken,
    }).toString(),
    redirect: "manual",
  })
  return response
}

/**
 * Extract a named cookie value from Set-Cookie headers.
 */
function extractCookieValue(response: Response, cookieName: string): string | null {
  const setCookieHeaders = response.headers.getSetCookie?.() ?? []
  for (const header of setCookieHeaders) {
    const match = header.match(new RegExp(`${cookieName}=([^;]+)`))
    if (match?.[1]) {
      return match[1]
    }
  }
  // Fallback: check raw set-cookie header
  const raw = response.headers.get("set-cookie")
  if (raw) {
    const match = raw.match(new RegExp(`${cookieName}=([^;]+)`))
    if (match?.[1]) {
      return match[1]
    }
  }
  return null
}

function extractSessionCookieByNames(response: Response, cookieNames: ReadonlyArray<string>): string | null {
  for (const cookieName of cookieNames) {
    const cookieValue = extractCookieValue(response, cookieName)
    if (cookieValue) {
      return `${cookieName}=${cookieValue}`
    }
  }
  return null
}

async function planeJsonGet<T>(baseUrl: string, path: string, sessionCookie: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Cookie: sessionCookie,
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Plane GET ${path} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`)
  }
  return (await response.json()) as T
}

async function planeJsonPost<T>(baseUrl: string, path: string, sessionCookie: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Plane POST ${path} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`)
  }
  return (await response.json()) as T
}

async function planeJsonDelete(baseUrl: string, path: string, sessionCookie: string): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      Cookie: sessionCookie,
    },
  })
  if (!response.ok && response.status !== 204) {
    const text = await response.text().catch(() => "")
    throw new Error(`Plane DELETE ${path} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`)
  }
}

async function planeApiKeyJsonGet<T>(baseUrl: string, path: string, apiKey: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Api-Key": apiKey,
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Plane GET ${path} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`)
  }
  return (await response.json()) as T
}

async function planeApiKeyJsonPost<T>(baseUrl: string, path: string, apiKey: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Plane POST ${path} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`)
  }
  return (await response.json()) as T
}

async function planeApiKeyJsonPatch<T>(baseUrl: string, path: string, apiKey: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Plane PATCH ${path} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`)
  }
  return (await response.json()) as T
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
 * Returns the authenticated admin session cookie header value.
 */
async function ensureAdminUser(baseUrl: string): Promise<string> {
  // Try sign-in first
  const signInResponse = await planeFormPost(baseUrl, "/api/instances/admins/sign-in/", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  })
  const signInCookie = extractSessionCookieByNames(signInResponse, ["admin-session-id", "accessToken"])
  if (signInCookie) {
    return signInCookie
  }

  // Fall back to sign-up
  const signUpResponse = await planeFormPost(baseUrl, "/api/instances/admins/sign-up/", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    first_name: ADMIN_FIRST_NAME,
    last_name: ADMIN_LAST_NAME,
    company_name: COMPANY_NAME,
  })
  const signUpCookie = extractSessionCookieByNames(signUpResponse, ["admin-session-id", "accessToken"])
  if (signUpCookie) {
    return signUpCookie
  }

  throw new Error(
    `Failed to authenticate admin user. Sign-in status: ${signInResponse.status}, Sign-up status: ${signUpResponse.status}`,
  )
}

async function ensureAppUserSession(baseUrl: string): Promise<string> {
  const response = await planeFormPost(baseUrl, "/auth/sign-in/", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  })
  const sessionCookie = extractSessionCookieByNames(response, ["session-id", "accessToken"])
  if (sessionCookie) {
    return sessionCookie
  }

  throw new Error(`Failed to authenticate app user session. Sign-in status: ${response.status}`)
}

/**
 * Ensure the "symphony" workspace exists. Returns the workspace slug.
 */
async function ensureWorkspace(baseUrl: string, adminSessionCookie: string): Promise<string> {
  const workspaces = await planeJsonGet<PaginatedResults<WorkspaceEntry>>(
    baseUrl,
    "/api/instances/workspaces/",
    adminSessionCookie,
  )
  const existing = (workspaces.results ?? []).find((ws) => ws.slug === WORKSPACE_SLUG)
  if (existing) {
    return existing.slug ?? WORKSPACE_SLUG
  }

  const created = await planeJsonPost<WorkspaceEntry>(baseUrl, "/api/instances/workspaces/", adminSessionCookie, {
    name: WORKSPACE_NAME,
    slug: WORKSPACE_SLUG,
  })
  return created.slug ?? WORKSPACE_SLUG
}

/**
 * Ensure the "SYM" project exists in the workspace. Returns the project ID.
 */
async function ensureProject(baseUrl: string, appSessionCookie: string, workspaceSlug: string): Promise<string> {
  const projectList = await planeJsonGet<{ results?: ReadonlyArray<ProjectEntry> }>(
    baseUrl,
    `/api/workspaces/${workspaceSlug}/projects/`,
    appSessionCookie,
  )
  const existing = (projectList.results ?? []).find((p) => p.identifier === PROJECT_IDENTIFIER)
  if (existing?.id) {
    return existing.id
  }

  const created = await planeJsonPost<ProjectEntry>(
    baseUrl,
    `/api/workspaces/${workspaceSlug}/projects/`,
    appSessionCookie,
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
 * Fetches states to resolve configured state UUIDs, checks existing issues by
 * name, updates mismatched state/description when needed, and creates only
 * missing issues.
 */
async function ensureSeedIssues(
  baseUrl: string,
  apiKey: string,
  workspaceSlug: string,
  projectId: string,
): Promise<void> {
  // Fetch project states so each seed can resolve its configured state UUID.
  const stateList = await planeApiKeyJsonGet<{ results?: ReadonlyArray<StateEntry> }>(
    baseUrl,
    `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/states/`,
    apiKey,
  )
  const states = stateList.results ?? []
  const stateIdsByName = new Map(
    states.flatMap((state) =>
      typeof state.name === "string" && typeof state.id === "string"
        ? [[state.name, state.id] as const]
        : [],
    ),
  )

  // Fetch existing issues
  const issueList = await planeApiKeyJsonGet<{ results?: ReadonlyArray<IssueEntry> }>(
    baseUrl,
    `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/work-items/`,
    apiKey,
  )
  const existingByName = new Map(
    (issueList.results ?? []).flatMap((issue) =>
      typeof issue.id === "string" && typeof issue.name === "string"
        ? [[issue.name, issue] as const]
        : [],
    ),
  )

  // Create missing seed issues or normalize state/description on existing ones.
  for (const seed of SEED_ISSUES) {
    const stateId = stateIdsByName.get(seed.stateName)
    if (!stateId) {
      throw new Error(
        `Could not find "${seed.stateName}" state in project ${projectId}. Available: ${[...stateIdsByName.keys()].join(", ")}`,
      )
    }

    const existing = existingByName.get(seed.name)
    if (existing?.id) {
      const existingStateId =
        typeof existing.state === "string" ? existing.state : existing.state?.id
      if (existingStateId !== stateId) {
        await planeApiKeyJsonPatch(
          baseUrl,
          `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/work-items/${existing.id}/`,
          apiKey,
          {
            state: stateId,
            description_html: seed.descriptionHtml,
          },
        )
      }
      continue
    }

    await planeApiKeyJsonPost(
      baseUrl,
      `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/work-items/`,
      apiKey,
      {
        name: seed.name,
        state: stateId,
        description_html: seed.descriptionHtml,
      },
    )
  }
}

/**
 * Ensure an API token labelled "symphony-dev" exists.
 * Since we can't retrieve the token value after creation,
 * we delete any existing one and create a fresh one.
 * Returns the token string.
 *
 * NOTE: This is intentionally destructive (not idempotent). Plane's API does
 * not return token values after initial creation, so we must delete-and-recreate
 * to obtain a usable token string.
 */
async function ensureApiToken(baseUrl: string, appSessionCookie: string): Promise<string> {
  const tokens = await planeJsonGet<ReadonlyArray<ApiTokenEntry>>(baseUrl, "/api/users/api-tokens/", appSessionCookie)

  // Delete existing symphony-dev token if found (can't retrieve its value)
  const existing = tokens.find((t) => t.label === API_TOKEN_LABEL)
  if (existing?.id) {
    await planeJsonDelete(baseUrl, `/api/users/api-tokens/${existing.id}/`, appSessionCookie)
  }

  // Create a new token
  const created = await planeJsonPost<ApiTokenEntry>(baseUrl, "/api/users/api-tokens/", appSessionCookie, {
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
 * 1. Reads existing bootstrap.json, validates API key still works
 * 2. If valid: still reconciles workspace/project/seed issues so local dev stays current
 * 3. Otherwise: creates/signs in admin -> ensures workspace -> signs into app -> ensures project -> creates API token -> seeds issues -> saves state
 */
export async function ensurePlaneBootstrap(baseUrl: string, stateDir: string): Promise<BootstrapResult> {
  // Check for existing valid state
  const cached = await readBootstrapState(stateDir)
  if (cached) {
    const valid = await validateApiKey(baseUrl, cached.apiKey)
    if (valid) {
      process.stdout.write("Plane bootstrap: existing API key is valid, reconciling seed issues\n")
      await ensureSeedIssues(baseUrl, cached.apiKey, cached.workspaceSlug, cached.projectId)
      await writeBootstrapState(stateDir, cached)
      return cached
    }
    process.stdout.write("Plane bootstrap: existing API key is invalid, re-bootstrapping\n")
  }

  process.stdout.write("Plane bootstrap: creating admin user\n")
  const adminSessionCookie = await ensureAdminUser(baseUrl)

  process.stdout.write("Plane bootstrap: ensuring workspace\n")
  const workspaceSlug = await ensureWorkspace(baseUrl, adminSessionCookie)

  process.stdout.write("Plane bootstrap: signing in app user\n")
  const appSessionCookie = await ensureAppUserSession(baseUrl)

  process.stdout.write("Plane bootstrap: ensuring project\n")
  const projectId = await ensureProject(baseUrl, appSessionCookie, workspaceSlug)

  process.stdout.write("Plane bootstrap: creating API token\n")
  const apiKey = await ensureApiToken(baseUrl, appSessionCookie)

  process.stdout.write("Plane bootstrap: seeding issues\n")
  await ensureSeedIssues(baseUrl, apiKey, workspaceSlug, projectId)

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
