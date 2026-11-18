import type { Store } from './store'

export const ACTIVE_REC_INDEX_KEY = 'rec:active:all'
export const ACTIVE_REC_TTL_SECONDS = 6 * 3600
const WATCH_SESSION_LOCK_SECONDS = 7200

export type RecPlatform = 'chaturbate' | 'tiktok' | 'stripchat' | 'universal'

export interface ActiveRecording {
  id: string
  platform: RecPlatform
  model: string
  target: string
  chatId: number
  source: 'manual' | 'watch' | 'continuation'
  startedAt: number
}

export interface StartRecordingInput {
  platform: string
  model: string
  target: string
  chatId: number
  source?: ActiveRecording['source']
  startedAt?: number
  skipWatchLock?: boolean
}

export function normalizeRecPlatform(raw: string): RecPlatform {
  const lower = String(raw || '').toLowerCase().trim()
  if (lower === 'chaturbate' || lower === 'cb') return 'chaturbate'
  if (lower === 'tiktok' || lower === 'tiktok live' || lower === 'tt') return 'tiktok'
  if (lower === 'stripchat' || lower === 'sc') return 'stripchat'
  return 'universal'
}

export function normalizeRecModel(raw: string): string {
  return String(raw || '').trim().replace(/^@/, '').toLowerCase()
}

export function watchLockKey(platform: string, identifier: string): string {
  return `watch:lock:${platform.toLowerCase()}:${identifier.toLowerCase().replace(/^@/, '')}`
}

function isWatchPlatform(platform: RecPlatform): platform is 'chaturbate' | 'tiktok' | 'stripchat' {
  return platform === 'chaturbate' || platform === 'tiktok' || platform === 'stripchat'
}

function parseActiveList(raw: string | null, now = Date.now()): ActiveRecording[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const maxAgeMs = ACTIVE_REC_TTL_SECONDS * 1000
    return (parsed as ActiveRecording[])
      .filter((item) => item && typeof item.model === 'string' && typeof item.startedAt === 'number' && now - item.startedAt < maxAgeMs)
      .sort((a, b) => a.startedAt - b.startedAt)
  } catch {
    return []
  }
}

export async function listActiveRecordings(store: Store, chatId?: number): Promise<ActiveRecording[]> {
  const list = parseActiveList(await store.get(ACTIVE_REC_INDEX_KEY))
  if (chatId == null) return list
  return list.filter((item) => item.chatId === chatId)
}

export async function getActiveRecording(
  store: Store,
  platform: string,
  model: string,
): Promise<ActiveRecording | null> {
  const normPlatform = normalizeRecPlatform(platform)
  const normModel = normalizeRecModel(model)
  if (!normModel) return null

  const list = await listActiveRecordings(store)
  const found = list.find(
    (item) =>
      item.model === normModel &&
      (item.platform === normPlatform || item.platform === 'universal' || normPlatform === 'universal'),
  )
  if (found) return found

  if (isWatchPlatform(normPlatform)) {
    const lockVal = await store.get(watchLockKey(normPlatform, normModel))
    if (lockVal) {
      const ts = Number(lockVal)
      const startedAt = Number.isFinite(ts) && ts > 0 ? ts : Date.now()
      return {
        id: `${normPlatform}:${normModel}`,
        platform: normPlatform,
        model: normModel,
        target: normPlatform === 'tiktok' ? `@${normModel}` : normPlatform === 'stripchat' ? `https://stripchat.com/${normModel}` : normModel,
        chatId: 0,
        source: 'watch',
        startedAt,
      }
    }
  }

  return null
}

export async function markRecordingStarted(store: Store, input: StartRecordingInput): Promise<ActiveRecording> {
  const platform = normalizeRecPlatform(input.platform)
  const model = normalizeRecModel(input.model)
  const startedAt = typeof input.startedAt === 'number' && Number.isFinite(input.startedAt) ? input.startedAt : Date.now()
  const entry: ActiveRecording = {
    id: `${platform}:${model}`,
    platform,
    model,
    target: String(input.target || model).trim(),
    chatId: Number(input.chatId) || 0,
    source: input.source || 'manual',
    startedAt,
  }

  const existing = parseActiveList(await store.get(ACTIVE_REC_INDEX_KEY), startedAt)
  const next = existing.filter((item) => item.id !== entry.id)
  next.push(entry)
  await store.put(ACTIVE_REC_INDEX_KEY, JSON.stringify(next), ACTIVE_REC_TTL_SECONDS)

  if (!input.skipWatchLock && isWatchPlatform(platform) && model) {
    await store.put(watchLockKey(platform, model), String(startedAt), WATCH_SESSION_LOCK_SECONDS)
  }

  return entry
}

export async function markRecordingFinished(
  store: Store,
  model: string,
  platform?: string,
): Promise<boolean> {
  const normModel = normalizeRecModel(model)
  if (!normModel) return false

  const raw = await store.get(ACTIVE_REC_INDEX_KEY)
  if (!raw) return false

  const current = parseActiveList(raw)
  const normPlatform = platform ? normalizeRecPlatform(platform) : undefined
  const next = current.filter((item) => {
    if (item.model !== normModel) return true
    if (!normPlatform || normPlatform === 'universal' || item.platform === 'universal') return false
    return item.platform !== normPlatform
  })

  if (next.length === current.length) return false

  if (next.length === 0) {
    await store.delete(ACTIVE_REC_INDEX_KEY)
  } else {
    await store.put(ACTIVE_REC_INDEX_KEY, JSON.stringify(next), ACTIVE_REC_TTL_SECONDS)
  }
  return true
}

export async function clearAllActiveRecordings(store: Store): Promise<void> {
  if (await store.get(ACTIVE_REC_INDEX_KEY)) {
    await store.delete(ACTIVE_REC_INDEX_KEY)
  }
}
