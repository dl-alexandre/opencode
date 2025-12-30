import z from "zod"
import type { AuthStore } from "./auth-store"
import { FileAuthStore } from "./auth-store"
import { RequestContext } from "./request-context"
import { UnauthenticatedError } from "./server-store"

export namespace Auth {
  export const Oauth = z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
      enterpriseUrl: z.string().optional(),
    })
    .meta({ ref: "OAuth" })

  export const Api = z
    .object({
      type: z.literal("api"),
      key: z.string(),
    })
    .meta({ ref: "ApiAuth" })

  export const WellKnown = z
    .object({
      type: z.literal("wellknown"),
      key: z.string(),
      token: z.string(),
    })
    .meta({ ref: "WellKnownAuth" })

  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown]).meta({ ref: "Auth" })
  export type Info = z.infer<typeof Info>

  // Runtime mode detection
  export const isServerMode = () => process.env.OPENCODE_SERVER_MODE === "true"

  // AuthStore instances (lazily initialized)
  let fileAuthStore: FileAuthStore | undefined
  let serverAuthStore: any | undefined

  function getFileAuthStore(): FileAuthStore {
    if (!fileAuthStore) {
      fileAuthStore = new FileAuthStore()
    }
    return fileAuthStore
  }

  function getServerAuthStore(): any {
    if (!serverAuthStore) {
      const { ServerAuthStore } = require("./server-store")
      serverAuthStore = new ServerAuthStore()
    }
    return serverAuthStore
  }

  /**
   * Get authentication credentials for a provider.
   * In server mode, uses RequestContext to look up per-user credentials.
   * In CLI mode, uses file-based local credentials.
   */
  export async function get(providerID: string): Promise<Info | undefined> {
    const store = isServerMode() ? getServerAuthStore() : getFileAuthStore()
    const context = RequestContext.current()

    if (isServerMode()) {
      if (!context?.userKey) {
        throw new UnauthenticatedError(
          "Authentication required: missing user context in server mode",
        )
      }
      const result = await store.get(providerID, context.userKey, context.orgKey)
      return result ?? undefined
    } else {
      const result = await store.get(providerID)
      return result ?? undefined
    }
  }

  /**
   * Set authentication credentials for a provider.
   * In server mode, stores per-user credentials.
   * In CLI mode, stores local file-based credentials.
   */
  export async function set(key: string, info: Info): Promise<void> {
    const store = isServerMode() ? getServerAuthStore() : getFileAuthStore()
    const context = RequestContext.current()

    if (isServerMode()) {
      if (!context?.userKey) {
        throw new UnauthenticatedError(
          "Authentication required: missing user context in server mode",
        )
      }
      return await store.set(key, info, context.userKey, context.orgKey)
    } else {
      return await store.set(key, info)
    }
  }

  /**
   * Remove authentication credentials for a provider.
   * In server mode, removes per-user credentials.
   * In CLI mode, removes local file-based credentials.
   */
  export async function remove(key: string): Promise<void> {
    const store = isServerMode() ? getServerAuthStore() : getFileAuthStore()
    const context = RequestContext.current()

    if (isServerMode()) {
      if (!context?.userKey) {
        throw new UnauthenticatedError(
          "Authentication required: missing user context in server mode",
        )
      }
      return await store.remove(key, context.userKey, context.orgKey)
    } else {
      return await store.remove(key)
    }
  }

  /**
   * Legacy function: get all credentials (file-based only)
   * Used for CLI auth operations
   */
  export async function all(): Promise<Record<string, Info>> {
    if (isServerMode()) {
      throw new Error("Auth.all() is not supported in server mode - use Auth.get() with user context")
    }
    const store = getFileAuthStore()
    // FileAuthStore doesn't expose all(), so we'll read directly
    const filepath = (store as FileAuthStore & any).filepath || 
                     require("path").join(require("../global").Global.Path.data, "auth.json")
    const file = Bun.file(filepath)
    const data = await file.json().catch(() => ({}) as Record<string, unknown>)
    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value)
        if (!parsed.success) return acc
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )
  }
}
