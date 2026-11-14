import type { Env } from './types'

export interface Store {
  get(key: string): Promise<string | null>
  put(key: string, value: string, ttlSeconds?: number): Promise<void>
  delete(key: string): Promise<void>
  incr(key: string, ttlSeconds: number): Promise<number>
}

interface MemoryEntry {
  value: string
  expiresAt: number
}

class MemoryStore implements Store {
  private readonly entries = new Map<string, MemoryEntry>()

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return null
    }
    return entry.value
  }

  async put(key: string, value: string, ttlSeconds = 3600): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.entries.get(key)
    if (!entry || entry.expiresAt <= Date.now()) {
      this.entries.set(key, { value: '1', expiresAt: Date.now() + ttlSeconds * 1000 })
      return 1
    }
    const next = Number(entry.value) + 1
    entry.value = String(next)
    return next
  }
}

class KvStore implements Store {
  constructor(private readonly kv: KVNamespace) {}

  async get(key: string): Promise<string | null> {
    return await this.kv.get(key)
  }

  async put(key: string, value: string, ttlSeconds = 3600): Promise<void> {
    await this.kv.put(key, value, { expirationTtl: Math.max(60, ttlSeconds) })
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key)
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const next = Number((await this.kv.get(key)) ?? 0) + 1
    await this.put(key, String(next), ttlSeconds)
    return next
  }
}

/** Survives isolate restarts when a KV binding is configured; otherwise in-memory. */
const memory = new MemoryStore()

export function getStore(env: Env): Store {
  return env.CACHE ? new KvStore(env.CACHE) : memory
}

export interface RateLimit {
  ok: boolean
  used: number
  limit: number
  remaining: number
}

export async function checkRateLimit(
  store: Store,
  subject: string | number,
  limit: number,
  windowSeconds = 60,
): Promise<RateLimit> {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000))
  const used = await store.incr(`rl:${subject}:${bucket}`, windowSeconds + 5)
  return { ok: used <= limit, used, limit, remaining: Math.max(0, limit - used) }
}
