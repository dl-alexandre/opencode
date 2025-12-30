import { AsyncLocalStorage } from "async_hooks"

export type TokenState = {
  accessToken: string
  expiresAt: number // unix seconds
  refreshedThisRequest?: boolean
  refreshAttemptedAt?: number
  source?: string
}

export interface RequestContextData {
  userKey: string
  orgKey: string
  tokenCache: Map<string, TokenState>
  refreshBudget: Set<string> // providerIds: max one refresh attempt per provider per request
}

export class RequestContext {
  private static storage = new AsyncLocalStorage<RequestContextData>()

  static run<T>(context: RequestContextData, fn: () => T): T {
    return this.storage.run(context, fn)
  }

  static current(): RequestContextData | null {
    return this.storage.getStore() ?? null
  }
}
