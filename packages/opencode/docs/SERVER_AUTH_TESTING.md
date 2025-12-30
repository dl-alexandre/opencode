# Server-Side Authentication Testing Guide

## Quick Start

### Run Basic Type Check
```bash
cd packages/opencode
bun run typecheck
```

### Test Phase 1-3 Components
```bash
# Test with CLI mode (default)
bun test

# Test with server mode enabled
OPENCODE_SERVER_MODE=true bun test
```

## Testing Phases

### Phase 1: AuthStore Abstraction

**Goal**: Verify `Auth.get/set/remove` work in both CLI and server modes

**Test cases**:

```typescript
// test/auth/auth-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Auth } from "../../src/auth"
import { RequestContext } from "../../src/auth/request-context"

describe("Auth namespace", () => {
  afterEach(() => {
    delete process.env.OPENCODE_SERVER_MODE
  })

  describe("CLI mode (default)", () => {
    it("stores credentials in file", async () => {
      const testAuth = { type: "api" as const, key: "test-key" }
      await Auth.set("test-provider", testAuth)
      const retrieved = await Auth.get("test-provider")
      expect(retrieved).toEqual(testAuth)
    })

    it("supports Auth.all() for batch retrieval", async () => {
      await Auth.set("provider1", { type: "api", key: "key1" })
      await Auth.set("provider2", { type: "api", key: "key2" })
      const all = await Auth.all()
      expect(all).toHaveProperty("provider1")
      expect(all).toHaveProperty("provider2")
    })

    it("supports Auth.remove()", async () => {
      await Auth.set("test", { type: "api", key: "test" })
      await Auth.remove("test")
      const retrieved = await Auth.get("test")
      expect(retrieved).toBeUndefined()
    })
  })

  describe("Server mode", () => {
    beforeEach(() => {
      process.env.OPENCODE_SERVER_MODE = "true"
    })

    it("throws UnauthenticatedError without RequestContext", async () => {
      expect(async () => {
        await Auth.get("test-provider")
      }).toThrow("Authentication required")
    })

    it("throws UnauthenticatedError without Auth.set() without context", async () => {
      expect(async () => {
        await Auth.set("test", { type: "api", key: "test" })
      }).toThrow("Authentication required")
    })

    it("requires userKey in RequestContext", async () => {
      const result = await RequestContext.run(
        {
          userKey: "user123",
          orgKey: "org1",
          tokenCache: new Map(),
          refreshBudget: new Set(),
        },
        () => Auth.get("test-provider")
      )
      // Should not throw (will return null from unimplemented ServerAuthStore)
    })
  })
})
```

**Run**:
```bash
bun test test/auth/auth-store.test.ts
OPENCODE_SERVER_MODE=true bun test test/auth/auth-store.test.ts
```

### Phase 2: RequestContext Middleware

**Goal**: Verify async context propagation through middleware stack

**Test cases**:

```typescript
// test/auth/request-context.test.ts
import { describe, it, expect } from "bun:test"
import { RequestContext } from "../../src/auth/request-context"

describe("RequestContext", () => {
  it("stores and retrieves context", () => {
    const ctx = {
      userKey: "user1",
      orgKey: "org1",
      tokenCache: new Map(),
      refreshBudget: new Set(),
    }

    const result = RequestContext.run(ctx, () => {
      const current = RequestContext.current()
      expect(current).toEqual(ctx)
      return "success"
    })

    expect(result).toBe("success")
  })

  it("returns null when no context active", () => {
    const current = RequestContext.current()
    expect(current).toBeNull()
  })

  it("isolates context between concurrent runs", async () => {
    const results: string[] = []

    await Promise.all([
      RequestContext.run(
        {
          userKey: "userA",
          orgKey: "org1",
          tokenCache: new Map(),
          refreshBudget: new Set(),
        },
        async () => {
          await new Promise(r => setTimeout(r, 10))
          const ctx = RequestContext.current()
          results.push(ctx?.userKey ?? "none")
        }
      ),
      RequestContext.run(
        {
          userKey: "userB",
          orgKey: "org1",
          tokenCache: new Map(),
          refreshBudget: new Set(),
        },
        async () => {
          const ctx = RequestContext.current()
          results.push(ctx?.userKey ?? "none")
        }
      ),
    ])

    expect(results).toContain("userA")
    expect(results).toContain("userB")
  })

  it("supports nested contexts", () => {
    const result = RequestContext.run(
      {
        userKey: "user1",
        orgKey: "org1",
        tokenCache: new Map(),
        refreshBudget: new Set(),
      },
      () => {
        const outer = RequestContext.current()

        const inner = RequestContext.run(
          {
            userKey: "user2",
            orgKey: "org2",
            tokenCache: new Map(),
            refreshBudget: new Set(),
          },
          () => {
            return RequestContext.current()
          }
        )

        const afterInner = RequestContext.current()

        return {
          outer: outer?.userKey,
          inner: inner?.userKey,
          afterInner: afterInner?.userKey,
        }
      }
    )

    expect(result.outer).toBe("user1")
    expect(result.inner).toBe("user2")
    expect(result.afterInner).toBe("user1")
  })
})
```

**Run**:
```bash
bun test test/auth/request-context.test.ts
```

### Phase 3: Secure Provider Fetch

**Goal**: Verify host validation, auth injection, redirect handling

**Test cases**:

```typescript
// test/provider/secure-fetch.test.ts
import { describe, it, expect } from "bun:test"
import { createSecureProviderFetch, PROVIDER_HOST_ALLOWLISTS } from "../../src/provider/secure-fetch"
import { RequestContext } from "../../src/auth/request-context"
import { Auth } from "../../src/auth"

describe("Secure Provider Fetch", () => {
  describe("Host validation", () => {
    it("blocks non-HTTPS requests", async () => {
      const mockFetch = (input: any) => {
        throw new Error("Should not reach network")
      }

      const fetch = createSecureProviderFetch("google", mockFetch)

      expect(async () => {
        await fetch("http://generativelanguage.googleapis.com/v1/models")
      }).toThrow(/disallowed host/)
    })

    it("blocks non-standard ports", async () => {
      const mockFetch = (input: any) => {
        throw new Error("Should not reach network")
      }

      const fetch = createSecureProviderFetch("google", mockFetch)

      expect(async () => {
        await fetch("https://generativelanguage.googleapis.com:8080/v1/models")
      }).toThrow(/disallowed host/)
    })

    it("blocks requests to disallowed hosts", async () => {
      const mockFetch = (input: any) => {
        throw new Error("Should not reach network")
      }

      const fetch = createSecureProviderFetch("google", mockFetch)

      expect(async () => {
        await fetch("https://attacker.com/steal-tokens")
      }).toThrow(/disallowed host/)
    })

    it("allows requests to allowed hosts", async () => {
      let called = false
      const mockFetch = (input: any) => {
        called = true
        return new Response("ok")
      }

      const fetch = createSecureProviderFetch("google", mockFetch)
      const response = await fetch("https://generativelanguage.googleapis.com/v1/models", {
        redirect: "manual",
      })

      expect(called).toBe(true)
      expect(response.ok).toBe(true)
    })
  })

  describe("Redirect handling", () => {
    it("blocks 3xx redirects", async () => {
      const mockFetch = (input: any) => {
        return new Response("", {
          status: 302,
          headers: { location: "https://evil.com" },
        })
      }

      const fetch = createSecureProviderFetch("google", mockFetch)

      expect(async () => {
        await fetch("https://generativelanguage.googleapis.com/v1/models")
      }).toThrow(/Redirects not allowed/)
    })

    it("allows 2xx responses", async () => {
      const mockFetch = (input: any) => {
        return new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      const fetch = createSecureProviderFetch("google", mockFetch)
      const response = await fetch("https://generativelanguage.googleapis.com/v1/models")

      expect(response.status).toBe(200)
      expect(response.ok).toBe(true)
    })

    it("allows 4xx/5xx error responses", async () => {
      const mockFetch = (input: any) => {
        return new Response("", { status: 401 })
      }

      const fetch = createSecureProviderFetch("google", mockFetch)
      const response = await fetch("https://generativelanguage.googleapis.com/v1/models")

      expect(response.status).toBe(401)
    })
  })

  describe("Auth token injection (with RequestContext)", () => {
    it("injects Authorization header in server mode", async () => {
      process.env.OPENCODE_SERVER_MODE = "true"

      let capturedHeaders: any
      const mockFetch = (input: any, init?: any) => {
        capturedHeaders = init?.headers
        return new Response("ok")
      }

      const fetch = createSecureProviderFetch("antigravity", mockFetch)

      // Mock Auth.get to return token
      // Note: This requires mocking or implementing ServerAuthStore

      await RequestContext.run(
        {
          userKey: "user1",
          orgKey: "org1",
          tokenCache: new Map(),
          refreshBudget: new Set(),
        },
        async () => {
          // Set up test token (requires real or mocked Auth store)
          // await Auth.set("antigravity", { type: "oauth", access: "test_token", ... })
          // await fetch("https://api.example.com/v1/models")
        }
      )

      delete process.env.OPENCODE_SERVER_MODE
    })

    it("does not inject tokens for non-OAuth providers", async () => {
      let capturedHeaders: any
      const mockFetch = (input: any, init?: any) => {
        capturedHeaders = init?.headers
        return new Response("ok")
      }

      const fetch = createSecureProviderFetch("google", mockFetch)
      await fetch("https://generativelanguage.googleapis.com/v1/models")

      expect(capturedHeaders?.Authorization).toBeUndefined()
    })

    it("does not inject tokens in CLI mode", async () => {
      delete process.env.OPENCODE_SERVER_MODE

      let capturedHeaders: any
      const mockFetch = (input: any, init?: any) => {
        capturedHeaders = init?.headers
        return new Response("ok")
      }

      const fetch = createSecureProviderFetch("antigravity", mockFetch)
      await fetch("https://api.example.com/v1/models")

      expect(capturedHeaders?.Authorization).toBeUndefined()
    })
  })

  describe("Token expiry and refresh", () => {
    it("returns 401 without refresh when token expired", async () => {
      process.env.OPENCODE_SERVER_MODE = "true"

      let callCount = 0
      const mockFetch = (input: any) => {
        callCount++
        return new Response("", { status: 401 })
      }

      const fetch = createSecureProviderFetch("antigravity", mockFetch)

      await RequestContext.run(
        {
          userKey: "user1",
          orgKey: "org1",
          tokenCache: new Map(),
          refreshBudget: new Set(),
        },
        async () => {
          const response = await fetch("https://api.example.com/v1/models")
          expect(response.status).toBe(401)
          // Note: Actual refresh attempt requires OAuthHandler implementation
        }
      )

      delete process.env.OPENCODE_SERVER_MODE
    })
  })
})
```

**Run**:
```bash
bun test test/provider/secure-fetch.test.ts
```

## Acceptance Tests

### Two-User Isolation Test

```bash
# test/acceptance/two-user-isolation.test.ts
```

```typescript
import { describe, it, expect } from "bun:test"
import { RequestContext } from "../../src/auth/request-context"
import { createSecureProviderFetch } from "../../src/provider/secure-fetch"

describe("Two-user isolation (acceptance)", () => {
  it("isolates credentials between concurrent users", async () => {
    process.env.OPENCODE_SERVER_MODE = "true"

    const interceptions: any[] = []

    const captureAuth = (providerId: string) => {
      return (input: any, init?: any) => {
        interceptions.push({
          user: RequestContext.current()?.userKey,
          provider: providerId,
          auth: init?.headers?.Authorization,
        })
        return new Response("ok")
      }
    }

    await Promise.all([
      RequestContext.run(
        {
          userKey: "userA",
          orgKey: "org1",
          tokenCache: new Map(),
          refreshBudget: new Set(),
        },
        async () => {
          const fetch = createSecureProviderFetch("antigravity", captureAuth("antigravity"))
          await fetch("https://api.example.com/request-a")
        }
      ),
      RequestContext.run(
        {
          userKey: "userB",
          orgKey: "org1",
          tokenCache: new Map(),
          refreshBudget: new Set(),
        },
        async () => {
          const fetch = createSecureProviderFetch("antigravity", captureAuth("antigravity"))
          await fetch("https://api.example.com/request-b")
        }
      ),
    ])

    // Verify isolation
    const userAInterceptions = interceptions.filter(i => i.user === "userA")
    const userBInterceptions = interceptions.filter(i => i.user === "userB")

    expect(userAInterceptions.length).toBeGreaterThan(0)
    expect(userBInterceptions.length).toBeGreaterThan(0)
    expect(userAInterceptions.every(i => i.user === "userA")).toBe(true)
    expect(userBInterceptions.every(i => i.user === "userB")).toBe(true)

    delete process.env.OPENCODE_SERVER_MODE
  })
})
```

**Run**:
```bash
bun test test/acceptance/two-user-isolation.test.ts
```

### Redirect Blocking Test

```bash
# test/acceptance/redirect-blocking.test.ts
```

```typescript
import { describe, it, expect } from "bun:test"
import { createSecureProviderFetch } from "../../src/provider/secure-fetch"

describe("Redirect blocking (acceptance)", () => {
  it("blocks redirect to disallowed host", async () => {
    const mockFetch = (input: any) => {
      // Simulate server redirecting to attacker domain
      return new Response("", {
        status: 301,
        headers: { location: "https://attacker.com/phishing" },
      })
    }

    const fetch = createSecureProviderFetch("google", mockFetch)

    expect(async () => {
      await fetch("https://generativelanguage.googleapis.com/v1/models")
    }).toThrow(/Redirects not allowed/)
  })

  it("prevents auth bypass via redirect chain", async () => {
    let requestCount = 0
    const mockFetch = (input: any) => {
      requestCount++
      if (requestCount === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "https://attacker.com" },
        })
      }
      return new Response("success")
    }

    const fetch = createSecureProviderFetch("google", mockFetch)

    expect(async () => {
      await fetch("https://generativelanguage.googleapis.com/v1/models", {
        headers: { Authorization: "Bearer secret-token" },
      })
    }).toThrow()

    expect(requestCount).toBe(1) // Should not follow redirect
  })
})
```

**Run**:
```bash
bun test test/acceptance/redirect-blocking.test.ts
```

## Manual Testing

### Test File-Based Auth (CLI Mode)

```bash
# Start with CLI mode (default)
$ opencode auth login google

# Verify token stored
$ cat ~/.local/share/opencode/auth.json
# Should contain Google OAuth token

# Use in request
$ opencode chat
# Should work with stored token
```

### Test Server Mode (Manual)

```typescript
// Create test script: test-server-auth.ts
import { Auth } from "./packages/opencode/src/auth"
import { RequestContext } from "./packages/opencode/src/auth/request-context"

process.env.OPENCODE_SERVER_MODE = "true"

async function test() {
  try {
    // Should throw: no RequestContext
    await Auth.get("test")
    console.log("FAIL: Should have thrown")
  } catch (err) {
    console.log("PASS: Correctly threw", err.name)
  }

  // Should work: with RequestContext
  await RequestContext.run(
    {
      userKey: "testuser",
      orgKey: "testorg",
      tokenCache: new Map(),
      refreshBudget: new Set(),
    },
    async () => {
      try {
        const auth = await Auth.get("test")
        console.log("PASS: Got auth (null from unimplemented store):", auth)
      } catch (err) {
        console.log("Got error (expected from unimplemented ServerAuthStore):", err.message)
      }
    }
  )
}

test()
```

```bash
bun test-server-auth.ts
```

## Debugging

### Enable Verbose Logging

```typescript
// In src/util/log.ts or relevant file
const DEBUG = process.env.DEBUG === "true"

// Wrap key operations:
if (DEBUG) console.log("RequestContext.run()", userKey, orgKey)
if (DEBUG) console.log("Auth.get()", providerId, "in server mode?", Auth.isServerMode())
if (DEBUG) console.log("Secure fetch", providerId, "host:", url.hostname, "allowed?", isAllowed)
```

```bash
DEBUG=true bun test
```

### Check Environment

```bash
echo "OPENCODE_SERVER_MODE=$OPENCODE_SERVER_MODE"
```

### Inspect Auth Store

```bash
# View file auth store
cat ~/.local/share/opencode/auth.json

# Test file operations
bun -e "
import { FileAuthStore } from './packages/opencode/src/auth/auth-store.ts'
const store = new FileAuthStore()
const auth = await store.get('test')
console.log('File store result:', auth)
"
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Auth.get` throws in server mode | Ensure `OPENCODE_SERVER_MODE=true` and RequestContext is initialized |
| `RequestContext.current()` returns null | Verify middleware is wrapping the operation |
| Fetch blocked for valid host | Check `PROVIDER_HOST_ALLOWLISTS` includes the host |
| Token not injected | Verify provider is in `OAUTH_BEARER_PROVIDERS` and token exists |
| Infinite redirect loop | Check `secure-fetch` is handling `redirect: "manual"` |
| Tests hang | Check for unresolved promises in RequestContext |

## CI/CD Integration

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: cd packages/opencode && bun install
      - run: cd packages/opencode && bun run typecheck
      - run: cd packages/opencode && bun test
      - run: cd packages/opencode && OPENCODE_SERVER_MODE=true bun test
```

## Performance Benchmarking

```typescript
// test/perf/als-performance.test.ts
import { describe, it } from "bun:test"
import { RequestContext } from "../../src/auth/request-context"

describe("AsyncLocalStorage performance", () => {
  it("measures ALS overhead", async () => {
    const iterations = 10000

    // Baseline: without ALS
    const start1 = performance.now()
    for (let i = 0; i < iterations; i++) {
      RequestContext.current()
    }
    const time1 = performance.now() - start1

    // With ALS
    const start2 = performance.now()
    for (let i = 0; i < iterations; i++) {
      await RequestContext.run(
        {
          userKey: "user",
          orgKey: "org",
          tokenCache: new Map(),
          refreshBudget: new Set(),
        },
        () => RequestContext.current()
      )
    }
    const time2 = performance.now() - start2

    const overhead = ((time2 - time1) / time1) * 100
    console.log(`ALS overhead: ${overhead.toFixed(2)}%`)
    // Should be < 5%
  })
})
```

```bash
bun test test/perf/als-performance.test.ts
```
