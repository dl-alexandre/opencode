import type { AuthStore } from "./auth-store"
import { Auth } from "./index"

/**
 * Typed auth errors for proper HTTP status mapping and type safety
 */
export class UnauthenticatedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnauthenticatedError"
    Object.setPrototypeOf(this, UnauthenticatedError.prototype)
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ForbiddenError"
    Object.setPrototypeOf(this, ForbiddenError.prototype)
  }
}

/**
 * ServerAuthStore implements server-side credential storage with per-user isolation.
 * Used in server/web mode; requires userKey for all operations.
 * Credentials are stored in database with encryption for refresh tokens.
 *
 * TODO: Implement database integration when DB layer is available.
 * For now, this throws NotImplementedError to indicate missing database integration.
 */
export class ServerAuthStore implements AuthStore {
  async get(providerId: string, userKey?: string, orgKey?: string): Promise<Auth.Info | null> {
    if (!userKey) {
      throw new UnauthenticatedError("userKey required in server mode")
    }

    // TODO: Implement database lookup
    // const row = await Database.getUserToken(orgKey ?? 'default', userKey, providerId)
    // if (!row) return null
    // return this.reconstructAuthInfo(row)
    throw new Error("ServerAuthStore not yet implemented - database integration required")
  }

  async set(providerId: string, auth: Auth.Info, userKey?: string, orgKey?: string): Promise<void> {
    if (!userKey) {
      throw new UnauthenticatedError("userKey required in server mode")
    }

    // TODO: Implement database upsert
    // const dbData = this.serializeAuthInfo(auth)
    // await Database.setUserToken(orgKey ?? 'default', userKey, providerId, dbData)
    throw new Error("ServerAuthStore not yet implemented - database integration required")
  }

  async remove(providerId: string, userKey?: string, orgKey?: string): Promise<void> {
    if (!userKey) {
      throw new UnauthenticatedError("userKey required in server mode")
    }

    // TODO: Implement database delete
    // await Database.removeUserToken(orgKey ?? 'default', userKey, providerId)
    throw new Error("ServerAuthStore not yet implemented - database integration required")
  }

  /**
   * Reconstruct Auth.Info from database row
   * @private
   */
  private reconstructAuthInfo(row: any): Auth.Info {
    if (row.token_type === "oauth" && row.refresh_token) {
      return {
        type: "oauth",
        access: row.access_token || "",
        refresh: row.refresh_token,
        expires: row.expires_at,
        enterpriseUrl: row.enterprise_url,
      } as Auth.Info
    } else if (row.token_type === "api" && row.api_key) {
      return {
        type: "api",
        key: row.api_key,
      } as Auth.Info
    }

    throw new Error(`Unknown auth token type: ${row.token_type}`)
  }

  /**
   * Serialize Auth.Info to database format
   * @private
   */
  private serializeAuthInfo(auth: Auth.Info): Record<string, any> {
    if (auth.type === "oauth") {
      return {
        token_type: "oauth",
        access_token: auth.access,
        refresh_token: auth.refresh,
        expires_at: auth.expires,
        enterprise_url: auth.enterpriseUrl,
      }
    } else if (auth.type === "api") {
      return {
        token_type: "api",
        api_key: auth.key,
      }
    }

    return {
      token_type: "wellknown",
      key: auth.type === "wellknown" ? (auth as any).key : undefined,
      token: auth.type === "wellknown" ? (auth as any).token : undefined,
    }
  }
}
