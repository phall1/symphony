import { stat } from "node:fs/promises"
import { extname, join, normalize, resolve } from "node:path"

type Args = {
  readonly root: string
  readonly port: number
  readonly host: string
  readonly label: string
  readonly basePath: string
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function parseArgs(argv: string[]): Args {
  const root = argv[2]?.trim()
  const port = parseInt(argv[3] ?? "", 10)
  const host = argv[4]?.trim() || "127.0.0.1"
  const label = argv[5]?.trim() || "plane-ui"
  const basePathRaw = argv[6]?.trim() || "/"
  const normalizedBasePath = basePathRaw === "/"
    ? "/"
    : `/${basePathRaw.replace(/^\/+|\/+$/g, "")}`

  if (!root || !Number.isInteger(port) || port <= 0) {
    process.stderr.write("Usage: bun run src/dev/plane-ui-server.ts <root> <port> [host] [label] [basePath]\n")
    process.exit(1)
  }

  return { root: resolve(root), port, host, label, basePath: normalizedBasePath }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function resolvePath(root: string, urlPath: string, basePath: string): Promise<string> {
  const decoded = decodeURIComponent(urlPath)
  const withoutBasePath = basePath !== "/" && decoded.startsWith(basePath)
    ? decoded.slice(basePath.length) || "/"
    : decoded
  const trimmed = withoutBasePath.replace(/^\/+/, "")
  const normalizedPath = normalize(trimmed)
  const candidate = resolve(root, normalizedPath)

  if (!candidate.startsWith(root)) {
    return join(root, "index.html")
  }

  if (await fileExists(candidate)) return candidate

  const indexCandidate = join(candidate, "index.html")
  if (await fileExists(indexCandidate)) return indexCandidate

  return join(root, "index.html")
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  const indexPath = join(args.root, "index.html")

  if (!(await fileExists(indexPath))) {
    process.stderr.write(`Missing SPA entrypoint: ${indexPath}\n`)
    process.exit(1)
  }

  Bun.serve({
    hostname: args.host,
    port: args.port,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (args.basePath !== "/" && url.pathname !== args.basePath && !url.pathname.startsWith(`${args.basePath}/`)) {
        return new Response("Not found", { status: 404 })
      }

      const path = await resolvePath(args.root, url.pathname, args.basePath)
      const file = Bun.file(path)

      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 })
      }

      const ext = extname(path)
      const headers = new Headers()
      headers.set("Cache-Control", path.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable")
      const contentType = MIME_TYPES[ext]
      if (contentType) headers.set("Content-Type", contentType)

      if (request.method === "HEAD") {
        const size = await file.size
        headers.set("Content-Length", String(size))
        return new Response(null, { status: 200, headers })
      }

      return new Response(file, { headers })
    },
  })

  process.stdout.write(`${args.label} listening on http://${args.host}:${args.port}${args.basePath === "/" ? "" : args.basePath} serving ${args.root}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
