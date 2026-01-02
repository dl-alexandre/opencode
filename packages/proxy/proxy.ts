import http, { IncomingMessage, ServerResponse } from "http"
import httpProxy from "http-proxy"
import dotenv from "dotenv"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import { fileURLToPath } from "url"

dotenv.config({ path: path.join(process.cwd(), ".env") })

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = Number(process.env.PORT || 4096)
const TARGET_HOST = process.env.TARGET_HOST || "127.0.0.1"
const TARGET_PORT = Number(process.env.TARGET_PORT || 4097)
const TOKEN_PATH =
  process.env.TOKEN_PATH || path.join(process.env.HOME || __dirname, ".opencode", "google-auth.json")
const AG_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI?.trim() ||
  process.env.ANTIGRAVITY_REDIRECT_URI?.trim() ||
  "http://localhost:4096/auth/google/callback"

const target = `http://${TARGET_HOST}:${TARGET_PORT}`

const AG_CLIENT_ID =
  process.env.GOOGLE_REDIRECT_CLIENT_ID?.trim() ||
  process.env.ANTIGRAVITY_REDIRECT_CLIENT_ID?.trim() ||
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const AG_CLIENT_SECRET =
  process.env.GOOGLE_REDIRECT_CLIENT_SECRET?.trim() ||
  process.env.ANTIGRAVITY_REDIRECT_CLIENT_SECRET?.trim() ||
  "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"
const AG_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
]
const AG_LOAD_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
]
const AG_HEADERS = {
  "User-Agent": "antigravity/1.11.5 windows/amd64",
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
} as const

const CALLBACK_PATH = (() => {
  try {
    const url = new URL(AG_REDIRECT_URI)
    return url.pathname || "/auth/google/callback"
  } catch {
    return "/auth/google/callback"
  }
})()

type TokenSuccess = {
  type: "success"
  refresh: string
  access: string
  expires: number
  email?: string
  projectId: string
}
type TokenPayload = TokenSuccess | { type: "failed"; error: string }

const base64url = (buf: Buffer): string =>
  buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

function encodeState(payload: { verifier: string; projectId: string }): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
}

function decodeState(state: string): { verifier: string; projectId: string; user?: string } {
  const normalized = state.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=")
  const json = Buffer.from(padded, "base64").toString("utf8")
  const parsed = JSON.parse(json)
  return { verifier: parsed.verifier || "", projectId: parsed.projectId || "", user: parsed.user || undefined }
}

function generatePkce() {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

type TokenStore = Record<string, TokenSuccess>

function loadTokens(): TokenStore {
  try {
    const raw = fs.readFileSync(TOKEN_PATH, "utf8")
    const parsed = JSON.parse(raw)
    if (typeof parsed !== "object" || !parsed) return {}
    return parsed as TokenStore
  } catch {
    return {}
  }
}

function persistTokens(store: TokenStore) {
  const dir = path.dirname(TOKEN_PATH)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(store, null, 2))
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchProjectID(accessToken: string): Promise<string> {
  const errors: string[] = []
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    ...AG_HEADERS,
  }
  for (const baseEndpoint of AG_LOAD_ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(`${baseEndpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
        }),
      })
      if (!response.ok) {
        errors.push(`loadCodeAssist ${response.status} at ${baseEndpoint}`)
        continue
      }
      const data = (await response.json()) as any
      if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) return data.cloudaicompanionProject
      if (data.cloudaicompanionProject?.id) return data.cloudaicompanionProject.id
      errors.push(`loadCodeAssist missing project id at ${baseEndpoint}`)
    } catch (e) {
      errors.push(`loadCodeAssist error at ${baseEndpoint}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (errors.length) console.warn("[auth] project discovery issues", errors.join("; "))
  return ""
}

async function authorizeAntigravity(projectId = "", user?: string) {
  const pkce = generatePkce()
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  url.searchParams.set("client_id", AG_CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", AG_REDIRECT_URI)
  url.searchParams.set("scope", AG_SCOPES.join(" "))
  url.searchParams.set("code_challenge", pkce.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set(
    "state",
    encodeState({ verifier: pkce.verifier, projectId: projectId || "", ...(user ? { user } : {}) }),
  )
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", "consent")
  return { url: url.toString(), verifier: pkce.verifier, projectId: projectId || "" }
}

async function exchangeAntigravity(code: string, state: string): Promise<TokenPayload> {
  try {
    const { verifier, projectId } = decodeState(state || "")
    const startTime = Date.now()
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: AG_CLIENT_ID,
        client_secret: AG_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: AG_REDIRECT_URI,
        code_verifier: verifier,
      }),
    })
    if (!tokenResponse.ok) {
      return { type: "failed", error: await tokenResponse.text() }
    }

    const tokenPayload = (await tokenResponse.json()) as {
      access_token: string
      expires_in: number
      refresh_token?: string
    }
    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
    })
    const userInfo = userInfoResponse.ok ? ((await userInfoResponse.json()) as { email?: string }) : {}

    const refreshToken = tokenPayload.refresh_token
    if (!refreshToken) return { type: "failed", error: "Missing refresh token in response" }

    const effectiveProjectId = projectId || (await fetchProjectID(tokenPayload.access_token)) || ""
    const storedRefresh = `${refreshToken}|${effectiveProjectId}`
    return {
      type: "success",
      refresh: storedRefresh,
      access: tokenPayload.access_token,
      expires: startTime + (tokenPayload.expires_in || 0) * 1000,
      email: userInfo.email,
      projectId: effectiveProjectId,
    }
  } catch (error) {
    return { type: "failed", error: error instanceof Error ? error.message : "Unknown error" }
  }
}

const proxy = httpProxy.createProxyServer({
  target,
  changeOrigin: true,
  ws: true,
})

proxy.on("error", (err, req, res) => {
  console.error("[proxy] error", err?.message)
  const response = res as ServerResponse | undefined
  if (response && !response.headersSent) {
    response.writeHead(502, { "Content-Type": "text/plain" })
    response.end("Proxy error")
  }
})

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)

  // Basic health checks
  if (url.pathname === "/health" || url.pathname === "/global/health") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ status: "ok", target }))
    return
  }

  // Friendly root page
  if (url.pathname === "/" || url.pathname === "") {
    const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>opencode proxy</title></head>
<body style="font-family: system-ui, -apple-system, sans-serif; padding: 24px;">
<h1>Opencode Proxy</h1>
<p>Status: <strong>OK</strong></p>
<p>Target: ${target}</p>
<ul>
  <li><a href="/health">/health</a></li>
  <li><a href="/auth/google/start">/auth/google/start</a></li>
</ul>
</body>
</html>`
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(body)
    return
  }

  // OAuth start
  if (url.pathname === "/auth/google/start") {
    try {
      const userHint = url.searchParams.get("user") || undefined
      const projectId = url.searchParams.get("project") || ""
      const result = await authorizeAntigravity(projectId, userHint)
      res.writeHead(302, { Location: result.url })
      res.end()
    } catch (err) {
      console.error("[auth:start] error", err)
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error)?.message || "auth start failed" }))
    }
    return
  }

  // OAuth callback
  if (url.pathname === CALLBACK_PATH || url.pathname === "/auth/google/callback") {
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state") || ""
    if (!code) {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "missing code" }))
      return
    }
    try {
      const result = await exchangeAntigravity(code, state)
      if (result.type !== "success") {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify(result))
        return
      }
      const stateData = decodeState(state)
      const key = stateData.user || result.email || "default"
      const payload = { ...result, storedAt: new Date().toISOString() }

      const store = loadTokens()
      store[key] = payload
      persistTokens(store)

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok", email: result.email, projectId: result.projectId, user: key }))
    } catch (err) {
      console.error("[auth:callback] error", err)
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error)?.message || "auth callback failed" }))
    }
    return
  }

  if (url.pathname === "/auth/google/token") {
    const user = url.searchParams.get("user") || "default"
    const store = loadTokens()
    const token = store[user]
    if (!token) {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "token not found", user }))
      return
    }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ user, token }))
    return
  }

  // Everything else gets proxied
  proxy.web(req, res, { target })
})

server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head)
})

server.listen(PORT, () => {
  console.log(`[proxy] listening on http://0.0.0.0:${PORT}, forwarding to ${target}`)
})
