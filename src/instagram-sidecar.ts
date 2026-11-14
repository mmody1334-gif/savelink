import { EngineError } from './errors'
import type { Env, MediaItem } from './types'

export interface InstagramSidecarHighlight {
  id: string
  title: string
  count: number
}

interface Target {
  endpoint: string
  token: string
}

/**
 * Instagram only answers a logged-in web session, and it rejects clients that
 * do not look like a browser (Workers have neither a browser TLS fingerprint
 * nor a movable IP). When the sidecar is configured it does those requests
 * instead, using curl_cffi behind an optional proxy.
 */
export function instagramSidecar(env: Env): Target | null {
  const endpoint = (env.IG_ENDPOINT || env.YTDLP_ENDPOINT || '').trim().replace(/\/+$/, '')
  if (!endpoint) return null
  return { endpoint, token: (env.IG_TOKEN || env.YTDLP_TOKEN || '').trim() }
}

async function call<T>(path: string, env: Env, timeoutMs = 25_000): Promise<T> {
  const target = instagramSidecar(env)
  if (!target) throw new EngineError('The Instagram helper is not configured.', 'instagram-sidecar', false)

  const headers: Record<string, string> = { accept: 'application/json' }
  if (target.token) headers.authorization = `Bearer ${target.token}`

  let response: Response
  try {
    response = await fetch(`${target.endpoint}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new EngineError(`Instagram helper unreachable: ${(error as Error).message}`, 'instagram-sidecar')
  }

  const text = await response.text()
  if (!response.ok) {
    let detail = text.slice(0, 200)
    try {
      detail = String((JSON.parse(text) as { detail?: unknown }).detail ?? detail)
    } catch {
      /* keep the raw body */
    }
    throw new EngineError(`Instagram helper (${response.status}): ${detail}`, 'instagram-sidecar')
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new EngineError('Instagram helper returned invalid JSON.', 'instagram-sidecar')
  }
}

export async function sidecarStories(
  username: string,
  env: Env,
): Promise<{ items: MediaItem[]; updatedAt?: number }> {
  const payload = await call<{ items?: MediaItem[]; updatedAt?: number }>(
    `/ig/stories?username=${encodeURIComponent(username)}`,
    env,
  )
  return { items: Array.isArray(payload.items) ? payload.items : [], updatedAt: payload.updatedAt }
}

export async function sidecarHighlights(username: string, env: Env): Promise<InstagramSidecarHighlight[]> {
  const payload = await call<{ highlights?: InstagramSidecarHighlight[] }>(
    `/ig/highlights?username=${encodeURIComponent(username)}`,
    env,
  )
  return Array.isArray(payload.highlights) ? payload.highlights : []
}

export async function sidecarHighlightItems(
  highlightId: string,
  env: Env,
): Promise<{ items: MediaItem[]; title?: string }> {
  const payload = await call<{ items?: MediaItem[]; title?: string }>(
    `/ig/highlight-items?id=${encodeURIComponent(highlightId)}`,
    env,
  )
  return { items: Array.isArray(payload.items) ? payload.items : [], title: payload.title }
}
