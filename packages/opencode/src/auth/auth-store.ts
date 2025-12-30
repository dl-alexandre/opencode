import path from "path"
import { Global } from "../global"
import fs from "fs/promises"
import { Auth } from "./index"

/**
 * AuthStore abstracts credential storage for both local file-based and server-side storage.
 * Implementations handle per-user credential persistence and retrieval.
 */
export interface AuthStore {
  /**
   * Get authentication credentials for a provider
   * @param providerId - Provider identifier (e.g., 'google', 'anthropic')
   * @param userKey - User identifier (ignored by FileAuthStore, required for ServerAuthStore)
   * @param orgKey - Organization identifier (ignored by FileAuthStore, used for ServerAuthStore)
   * @returns Authentication info or null if not found
   */
  get(providerId: string, userKey?: string, orgKey?: string): Promise<Auth.Info | null>

  /**
   * Set authentication credentials for a provider
   * @param providerId - Provider identifier
   * @param auth - Authentication info to store
   * @param userKey - User identifier (ignored by FileAuthStore, required for ServerAuthStore)
   * @param orgKey - Organization identifier (ignored by FileAuthStore, used for ServerAuthStore)
   */
  set(providerId: string, auth: Auth.Info, userKey?: string, orgKey?: string): Promise<void>

  /**
   * Remove authentication credentials for a provider
   * @param providerId - Provider identifier
   * @param userKey - User identifier
   * @param orgKey - Organization identifier
   */
  remove(providerId: string, userKey?: string, orgKey?: string): Promise<void>
}

/**
 * FileAuthStore implements local file-based credential storage.
 * Used in CLI mode; ignores userKey/orgKey parameters.
 * Credentials are stored in ~/.local/share/opencode/auth.json
 */
export class FileAuthStore implements AuthStore {
  private filepath: string

  constructor(filepath?: string) {
    this.filepath = filepath || path.join(Global.Path.data, "auth.json")
  }

  async get(providerId: string, _userKey?: string, _orgKey?: string): Promise<Auth.Info | null> {
    const auth = await this.all()
    return auth[providerId] ?? null
  }

  async set(providerId: string, auth: Auth.Info, _userKey?: string, _orgKey?: string): Promise<void> {
    const file = Bun.file(this.filepath)
    const data = await this.all()
    await Bun.write(file, JSON.stringify({ ...data, [providerId]: auth }, null, 2))
    await fs.chmod(file.name!, 0o600)
  }

  async remove(providerId: string, _userKey?: string, _orgKey?: string): Promise<void> {
    const file = Bun.file(this.filepath)
    const data = await this.all()
    delete data[providerId]
    await Bun.write(file, JSON.stringify(data, null, 2))
    await fs.chmod(file.name!, 0o600)
  }

  private async all(): Promise<Record<string, Auth.Info>> {
    const file = Bun.file(this.filepath)
    const data = await file.json().catch(() => ({}) as Record<string, unknown>)
    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Auth.Info.safeParse(value)
        if (!parsed.success) return acc
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Auth.Info>,
    )
  }
}
