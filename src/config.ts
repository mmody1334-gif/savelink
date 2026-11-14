import type { Env, Quality } from './types'

function megabytes(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : fallback) * 1024 * 1024
}

export function engineOrder(env: Env): string[] {
  return (env.ENGINE_ORDER ?? 'ytdlp,native,cobalt')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

export function maxUploadBytes(env: Env): number {
  return megabytes(env.MAX_UPLOAD_MB, 45)
}

export function maxProxyBytes(env: Env): number {
  return megabytes(env.MAX_PROXY_MB, 2048)
}

export function rateLimitPerMin(env: Env): number {
  const parsed = Number(env.RATE_LIMIT_PER_MIN)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12
}

/** How many recent profile photos a single request may bundle (Telegram album = 10). */
export function profileMaxItems(env: Env): number {
  const parsed = Number(env.PROFILE_MAX_ITEMS)
  // The public embed only carries the posts Instagram renders there (~6-40),
  // so the default sends everything it has. A higher value only matters when
  // PROFILE_SOURCE=api pulls the feed from the hosted Instagram API.
  if (!Number.isFinite(parsed) || parsed <= 0) return 60
  return Math.min(300, Math.floor(parsed))
}

export function publicBase(env: Env, fallback: string): string {
  const configured = env.PUBLIC_BASE_URL?.trim()
  const base = configured && configured.length > 0 ? configured : fallback
  return base.replace(/\/+$/, '')
}

const QUALITIES: Quality[] = ['max', '1080', '720', '480', '360', '240']

export function parseQuality(value: unknown): Quality {
  const raw = String(value ?? '').toLowerCase().replace(/p$/, '')
  return (QUALITIES as string[]).includes(raw) ? (raw as Quality) : '720'
}
