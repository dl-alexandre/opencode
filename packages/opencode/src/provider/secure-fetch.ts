import { Auth } from "../auth"
import { RequestContext } from "../auth/request-context"
import { OAuthHandler } from "../auth/oauth-handler"
import { Log } from "../util/log"

const log = Log.create({ service: "provider.secure-fetch" })

const EXPIRY_BUFFER_SECONDS = 300 // 5 min

/**
 * Provider host allowlists - define which hosts each provider can access
 * This is a security enforcement mechanism to prevent auth token leakage to untrusted hosts
 */
export const PROVIDER_HOST_ALLOWLISTS: Record<string, Set<string>> = {
  // Google Gemini / Vertex AI
  google: new Set([
    "generativelanguage.googleapis.com",
    "vertexai.googleapis.com",
    "aiplatform.googleapis.com",
  ]),
  "google-vertex": new Set([
    "us-central1-aiplatform.googleapis.com",
    "us-east4-aiplatform.googleapis.com",
    "us-west1-aiplatform.googleapis.com",
    "us-west4-aiplatform.googleapis.com",
    "europe-west1-aiplatform.googleapis.com",
    "europe-west4-aiplatform.googleapis.com",
    "asia-east1-aiplatform.googleapis.com",
    "asia-northeast1-aiplatform.googleapis.com",
    "asia-southeast1-aiplatform.googleapis.com",
  ]),
  // Anthropic
  anthropic: new Set(["api.anthropic.com"]),
  // OpenAI
  openai: new Set(["api.openai.com"]),
  // Other providers - add as needed
  openrouter: new Set(["openrouter.ai"]),
}

/**
 * Providers that accept OAuth access tokens as Bearer authentication
 * Only these providers will have auth tokens injected
 */
export const OAUTH_BEARER_PROVIDERS = new Set([
  "antigravity", // Google OAuth-backed provider (example)
  // Add other OAuth-backed providers here
])

interface TokenState {
  accessToken: string
  expiresAt: number
  refreshedThisRequest?: boolean
}

/**
 * Get valid OAuth token for a provider in server mode
 * Handles cached tokens, expiry checks, and on-demand refresh
 */
async function getValidTokenForRequest(
  providerId: string,
  context: NonNullable<ReturnType<typeof RequestContext.current>>,
): Promise<string | null> {
  const tokenState = context.tokenCache.get(providerId)
  const now = Math.floor(Date.now() / 1000)

  // Fast path: valid cached token
  if (tokenState && tokenState.expiresAt > now + EXPIRY_BUFFER_SECONDS && tokenState.accessToken) {
    return tokenState.accessToken
  }

  // Load fresh token from Auth store
  const auth = await Auth.get(providerId)
  if (!auth || auth.type !== "oauth") {
    return null
  }

  // Check if token needs refresh
  const needsRefresh = auth.expires && auth.expires <= now + EXPIRY_BUFFER_SECONDS
  if (needsRefresh && !context.refreshBudget.has(providerId)) {
    // Mark as refreshed to prevent double-refresh in same request
    context.refreshBudget.add(providerId)

    try {
      // Trigger refresh (deduped across instances via row locks)
      await OAuthHandler.refreshWithDedupe(providerId, context.userKey, context.orgKey)

      // Get refreshed token
      const refreshedAuth = await Auth.get(providerId)
      if (refreshedAuth?.type === "oauth") {
        context.tokenCache.set(providerId, {
          accessToken: refreshedAuth.access,
          expiresAt: refreshedAuth.expires || 0,
          refreshedThisRequest: true,
        })
        return refreshedAuth.access
      }
    } catch (err) {
      log.error("Token refresh failed", { providerId, error: err })
      // Fall through to use original token if still valid
    }
  }

  // Use current token if valid enough
  if (auth.expires && auth.expires > now + EXPIRY_BUFFER_SECONDS) {
    context.tokenCache.set(providerId, {
      accessToken: auth.access,
      expiresAt: auth.expires,
    })
    return auth.access
  }

  return null
}

/**
 * Validate that a URL is allowed for a provider
 * Enforces HTTPS, default ports, and provider host allowlist
 */
function isAllowedHost(url: URL, providerId: string): boolean {
  // SECURITY: Enforce HTTPS only (except local dev if explicitly configured)
  if (url.protocol !== "https:") {
    return false
  }

  // SECURITY: Enforce default ports only (443 for HTTPS)
  const port = url.port || "443"
  if (port !== "443") {
    return false
  }

  // Get provider's allowed hosts
  const allowedHosts = PROVIDER_HOST_ALLOWLISTS[providerId]
  if (!allowedHosts) {
    // If provider not in allowlist, deny by default (fail-closed)
    return false
  }

  // Normalize hostname (lowercase, punycode handling)
  const canonicalHost = url.hostname.toLowerCase()
  return allowedHosts.has(canonicalHost)
}

/**
 * Create a secure fetch wrapper for provider HTTP requests
 * Enforces:
 * - HTTPS only, default ports
 * - Provider host allowlists
 * - Auth token injection for OAuth providers
 * - Manual redirect handling (fail-closed)
 * - Single 401/403 retry with refresh
 */
export function createSecureProviderFetch(
  providerId: string,
  baseFetch: typeof fetch,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const isOAuthProvider = OAUTH_BEARER_PROVIDERS.has(providerId)

  return async function secureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // Resolve actual URL being fetched
    let url: URL
    try {
      if (typeof input === "string") {
        url = new URL(input)
      } else if (input instanceof URL) {
        url = input
      } else if (input instanceof Request) {
        url = new URL(input.url)
      } else {
        throw new Error("Unknown input type")
      }
    } catch (err) {
      throw new Error(`Invalid URL for provider fetch: ${err}`)
    }

    // SECURITY: Check URL is allowed
    if (!isAllowedHost(url, providerId)) {
      throw new Error(
        `SECURITY: Request to disallowed host blocked for provider ${providerId}: ${url.host}`,
      )
    }

    // First attempt
    const response = await doFetchOnce(input, init, url)

    // Handle 401/403 with optional retry after refresh
    if ((response.status === 401 || response.status === 403) && Auth.isServerMode() && isOAuthProvider) {
      const context = RequestContext.current()
      if (context && !context.refreshBudget.has(providerId)) {
        log.debug("Token auth failed, attempting refresh", {
          providerId,
          status: response.status,
        })

        context.refreshBudget.add(providerId)

        try {
          // Refresh token
          await OAuthHandler.refreshWithDedupe(providerId, context.userKey, context.orgKey)

          // Clear cache and retry
          context.tokenCache.delete(providerId)
          return doFetchOnce(input, init, url)
        } catch (err) {
          log.error("Refresh failed, using original response", { providerId, error: err })
        }
      }
    }

    return response
  }

  async function doFetchOnce(input: RequestInfo | URL, init: RequestInit | undefined, url: URL) {
    // Clone init to avoid mutations
    const nextInit: RequestInit = { ...init, redirect: "manual" }

    // Normalize and merge headers
    const headers = new Headers(init?.headers ?? {})

    // Inject auth token in server mode
    if (Auth.isServerMode() && isOAuthProvider) {
      const context = RequestContext.current()
      if (context) {
        const token = await getValidTokenForRequest(providerId, context)
        if (token) {
          headers.set("Authorization", `Bearer ${token}`)
          log.debug("Injected auth token", { providerId })
        }
      }
    }

    nextInit.headers = headers

    // Make request with manual redirect handling
    const response = await baseFetch(input, nextInit)

    // SECURITY: Fail closed on redirects (prevent auth header leakage)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      throw new Error(
        `SECURITY: Redirects not allowed for authenticated provider requests to ${providerId}${location ? ` (target: ${location})` : ""}`,
      )
    }

    return response
  }
}
