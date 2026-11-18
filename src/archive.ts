import { publicBase } from './config'
import { signToken, verifyToken } from './sign'
import type { Store } from './store'
import type { Env } from './types'

export const ARCHIVE_TTL_SECONDS = 60 * 60 * 24 * 365
export const MAX_ARCHIVE_ITEMS = 200
export const ARCHIVE_ALL_KEY = 'archive:all'

export type ArchivePlatform = 'chaturbate' | 'tiktok' | 'stripchat' | 'universal'
export type ArchiveSource = 'recorder' | 'uploader' | 'backfill'

export interface ArchiveEntry {
  id: string
  chatId: number
  platform: ArchivePlatform
  model: string
  url: string
  size?: string
  duration?: string
  source?: ArchiveSource
  createdAt: number
}

export interface ArchiveInput {
  chatId: number
  platform: ArchivePlatform | string
  model: string
  url: string
  size?: string
  duration?: string
  source?: ArchiveSource
  createdAt?: number
}

export interface ArchivePageToken {
  chatId: number
  scope: string
  exp: number
}

const ARCHIVE_DEV_SECRET = 'savelink-dev-signing-secret-change-me'

export function archiveUserKey(chatId: number | string): string {
  return `archive:user:${String(chatId)}`
}

function normalizePlatform(raw: string): ArchivePlatform {
  const lower = String(raw || '').toLowerCase().trim()
  if (lower === 'chaturbate' || lower === 'tiktok' || lower === 'stripchat') return lower
  return 'universal'
}

function normalizeModel(raw: string): string {
  return String(raw || '').trim().replace(/^@/, '').toLowerCase()
}

function parseEntries(raw: string | null): ArchiveEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ArchiveEntry[]) : []
  } catch {
    return []
  }
}

function upsertEntryList(list: ArchiveEntry[], entry: ArchiveEntry): ArchiveEntry[] {
  const existing = list.find((item) => item.url === entry.url)
  const merged: ArchiveEntry = existing
    ? {
        ...existing,
        ...entry,
        id: existing.id,
        size: entry.size || existing.size,
        duration: entry.duration || existing.duration,
        source: entry.source || existing.source,
        createdAt: existing.createdAt,
      }
    : entry
  const rest = list.filter((item) => item.url !== entry.url)
  return [merged, ...rest].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ARCHIVE_ITEMS)
}

function filterEntries(entries: ArchiveEntry[], query?: string): ArchiveEntry[] {
  const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt)
  const needle = (query || '').trim().replace(/^@/, '').toLowerCase()
  if (!needle) return sorted
  return sorted.filter(
    (entry) =>
      entry.model.toLowerCase().includes(needle) ||
      entry.platform.toLowerCase().includes(needle) ||
      entry.url.toLowerCase().includes(needle),
  )
}

export async function addArchiveEntry(store: Store, input: ArchiveInput): Promise<ArchiveEntry> {
  const url = String(input.url || '').trim()
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Archive entry URL must start with http:// or https://')
  }
  const model = normalizeModel(input.model)
  if (!model) {
    throw new Error('Archive entry model is required')
  }
  const chatId = Number(input.chatId)
  if (!Number.isFinite(chatId) || chatId === 0) {
    throw new Error('Valid chatId is required')
  }

  const createdAt = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) ? input.createdAt : Date.now()
  const entry: ArchiveEntry = {
    id: `${createdAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    chatId,
    platform: normalizePlatform(input.platform),
    model,
    url,
    ...(input.size ? { size: String(input.size).trim() } : {}),
    ...(input.duration ? { duration: String(input.duration).trim() } : {}),
    ...(input.source ? { source: input.source } : {}),
    createdAt,
  }

  const userKey = archiveUserKey(chatId)
  const [userRaw, allRaw] = await Promise.all([store.get(userKey), store.get(ARCHIVE_ALL_KEY)])
  const nextUser = upsertEntryList(parseEntries(userRaw), entry)
  const nextAll = upsertEntryList(parseEntries(allRaw), entry)
  const saved = nextUser.find((item) => item.url === url) || entry

  await Promise.all([
    store.put(userKey, JSON.stringify(nextUser), ARCHIVE_TTL_SECONDS),
    store.put(ARCHIVE_ALL_KEY, JSON.stringify(nextAll), ARCHIVE_TTL_SECONDS),
  ])

  return saved
}

export async function listArchiveEntries(store: Store, chatId: number, query?: string): Promise<ArchiveEntry[]> {
  const userEntries = parseEntries(await store.get(archiveUserKey(chatId)))
  if (userEntries.length > 0) {
    return filterEntries(userEntries, query)
  }
  const allEntries = parseEntries(await store.get(ARCHIVE_ALL_KEY)).filter((entry) => entry.chatId === chatId)
  return filterEntries(allEntries, query)
}

export async function listAllArchiveEntries(store: Store, query?: string): Promise<ArchiveEntry[]> {
  const allEntries = parseEntries(await store.get(ARCHIVE_ALL_KEY))
  return filterEntries(allEntries, query)
}

export async function deleteArchiveEntry(store: Store, chatId: number, id: string): Promise<boolean> {
  const targetId = String(id || '').trim()
  if (!targetId) return false
  const userKey = archiveUserKey(chatId)
  const [userRaw, allRaw] = await Promise.all([store.get(userKey), store.get(ARCHIVE_ALL_KEY)])
  const userList = parseEntries(userRaw)
  const allList = parseEntries(allRaw)

  const nextUser = userList.filter((item) => item.id !== targetId)
  const nextAll = allList.filter((item) => !(item.id === targetId && item.chatId === chatId))
  const removed = nextUser.length !== userList.length || nextAll.length !== allList.length
  if (!removed) return false

  await Promise.all([
    store.put(userKey, JSON.stringify(nextUser), ARCHIVE_TTL_SECONDS),
    store.put(ARCHIVE_ALL_KEY, JSON.stringify(nextAll), ARCHIVE_TTL_SECONDS),
  ])
  return true
}

export async function clearArchiveEntries(store: Store, chatId: number): Promise<number> {
  const userKey = archiveUserKey(chatId)
  const [userRaw, allRaw] = await Promise.all([store.get(userKey), store.get(ARCHIVE_ALL_KEY)])
  const userList = parseEntries(userRaw)
  const allList = parseEntries(allRaw)
  const nextAll = allList.filter((item) => item.chatId !== chatId)
  const removed = Math.max(userList.length, allList.length - nextAll.length)

  if (removed === 0) return 0

  const ops: Promise<void>[] = []
  if (userRaw !== null) {
    ops.push(store.delete(userKey))
  }
  if (allRaw !== null) {
    if (nextAll.length === 0) {
      ops.push(store.delete(ARCHIVE_ALL_KEY))
    } else if (nextAll.length !== allList.length) {
      ops.push(store.put(ARCHIVE_ALL_KEY, JSON.stringify(nextAll), ARCHIVE_TTL_SECONDS))
    }
  }
  await Promise.all(ops)
  return removed
}

function archiveSigningSecret(env: Env): string {
  return (env.SIGNING_SECRET || '').trim() || ARCHIVE_DEV_SECRET
}

export async function signArchivePageUrl(
  chatId: number,
  env: Env,
  requestOrigin: string,
  ttlSeconds = 7 * 86400,
): Promise<string> {
  const token = await signToken({ chatId, scope: 'archive' }, archiveSigningSecret(env), ttlSeconds)
  return `${publicBase(env, requestOrigin)}/archive?t=${token}`
}

export async function verifyArchivePageToken(token: string, env: Env): Promise<ArchivePageToken | null> {
  if (!token) return null
  const verified = await verifyToken<ArchivePageToken>(token, archiveSigningSecret(env))
  if (!verified || verified.scope !== 'archive' || !Number.isFinite(verified.chatId)) return null
  return verified
}
