import { EngineError } from './errors'
import { fetchJson, httpFetch } from './http'
import {
  instagramSidecar,
  sidecarHighlightItems,
  sidecarHighlights,
  sidecarStories,
} from './instagram-sidecar'
import { apiHighlightItems, apiHighlights, apiStories, instagramApi } from './instagram-public'
import { queryInstagramGraphQL } from './instagram-graphql'
import { igHeaders, igWebHeaders, resolveUserId } from './instagram-profile'
import { isInstagramUsername } from './platforms'
import type { Env, MediaItem } from './types'

const IG_REFERER = 'https://www.instagram.com/'

export interface InstagramStories {
  username: string
  items: MediaItem[]
  /** epoch seconds of the newest story item */
  updatedAt?: number
}

export interface InstagramHighlight {
  /** Instagram reel id, e.g. "highlight:17912345678901234" */
  id: string
  title: string
  count: number
}

function requireSession(env: Env, feature: string): void {
  if (!env.IG_COOKIE) {
    throw new EngineError(
      `${feature} need an Instagram session (IG_COOKIE) or an Instagram API key (IG_API_KEY).`,
      'instagram-stories',
      false,
    )
  }
}

function requireUsername(username: string): void {
  if (!isInstagramUsername(username)) {
    throw new EngineError('That is not a valid Instagram username.', 'instagram-stories', false)
  }
}

/**
 * Turns Instagram's private-API failures into a message the user can act on.
 * From Cloudflare, a session Instagram does not trust answers 401/403 (or the
 * 404 login wall) even when the cookie itself is well formed.
 */
async function privateApi<T>(url: string, env: Env, timeoutMs = 15_000): Promise<T> {
  try {
    return await fetchJson<T>(url, { headers: igHeaders(env) }, timeoutMs)
  } catch (error) {
    const status = Number(String(error).match(/HTTP (\d{3})/)?.[1])
    if (status === 401 || status === 403 || status === 404) {
      throw new EngineError(
        `Instagram refused the session (HTTP ${status}). The IG_COOKIE expired or Instagram blocks it from Cloudflare servers.`,
        'instagram-stories',
        false,
      )
    }
    throw error
  }
}

/**
 * Instagram answers an expired session with an empty payload instead of an
 * error, so an empty reel used to be shown as "no active stories". The probe
 * only runs when a result is already empty, so it never delays a good answer.
 */
let sessionProbe: { alive: boolean; at: number } | null = null
const SESSION_PROBE_MS = 5 * 60 * 1000

async function instagramSessionAlive(env: Env): Promise<boolean | null> {
  if (!env.IG_COOKIE) return false
  const now = Date.now()
  if (sessionProbe && now - sessionProbe.at < SESSION_PROBE_MS) return sessionProbe.alive
  try {
    const response = await httpFetch(
      'https://i.instagram.com/api/v1/accounts/current_user/?edit=true',
      { headers: igHeaders(env) },
      10_000,
    )
    const payload = JSON.parse(await response.text()) as any
    if (payload?.user?.pk || payload?.status === 'ok') {
      sessionProbe = { alive: true, at: now }
      return true
    }
    if (payload?.status === 'fail' || payload?.message) {
      sessionProbe = { alive: false, at: now }
      return false
    }
    return null
  } catch {
    // Inconclusive (network/HTML): never claim the session is dead.
    return null
  }
}

async function sidecarStoriesResult(
  username: string,
  env: Env,
): Promise<{ result?: InstagramStories; error?: Error }> {
  if (!instagramSidecar(env)) return {}
  try {
    const stories = await sidecarStories(username, env)
    if (!stories.items.length) return {}
    return { result: { username, items: stories.items, updatedAt: stories.updatedAt } }
  } catch (error) {
    return { error: error as Error }
  }
}

async function sidecarHighlightsResult(
  username: string,
  env: Env,
): Promise<{ result?: InstagramHighlight[]; error?: Error }> {
  if (!instagramSidecar(env)) return {}
  try {
    const highlights = await sidecarHighlights(username, env)
    if (!highlights.length) return {}
    return { result: highlights.map(({ id, title, count }) => ({ id, title, count })) }
  } catch (error) {
    return { error: error as Error }
  }
}

async function assertSessionForEmpty(feature: string, env: Env): Promise<void> {
  if ((await instagramSessionAlive(env)) !== false) return
  throw new EngineError(
    `Instagram rejected the stored session (IG_COOKIE has expired), so ${feature} cannot be read. ` +
      'Log in to instagram.com again, copy the fresh cookie and update IG_COOKIE.',
    'instagram-stories',
    false,
  )
}

/** reel.item -> MediaItem. Stories and highlights share the same shape. */
function reelItems(raw: unknown[]): MediaItem[] {
  const items: MediaItem[] = []
  for (const entry of raw) {
    const item = entry as any
    if (!item) continue
    if (item.media_type === 2 || (item.video_versions && item.video_versions.length > 0)) {
      const video = item.video_versions?.[0]
      if (!video?.url) continue
      items.push({
        kind: 'video',
        url: video.url,
        ext: 'mp4',
        mime: 'video/mp4',
        width: video.width,
        height: video.height,
        referer: IG_REFERER,
      })
    } else {
      const image = item.image_versions2?.candidates?.[0]
      if (!image?.url) continue
      items.push({
        kind: 'image',
        url: image.url,
        ext: 'jpg',
        mime: 'image/jpeg',
        width: image.width,
        height: image.height,
        referer: IG_REFERER,
      })
    }
  }
  return items
}

/** feed/reels_media answers either {reels:{id:…}} or {reels_media:[…]}. */
function pickReel(payload: any, id: string): any {
  if (payload?.reels && payload.reels[id]) return payload.reels[id]
  if (Array.isArray(payload?.reels_media)) {
    return payload.reels_media.find((reel: any) => String(reel?.id) === id)
  }
  return undefined
}

async function fetchReel(id: string, env: Env): Promise<any> {
  const path = `/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(id)}`
  try {
    return await privateApi<any>(`https://i.instagram.com${path}`, env, 15_000)
  } catch {
    // Some sessions only answer on the web host.
    return await privateApi<any>(`https://www.instagram.com${path}`, env, 15_000)
  }
}

export async function fetchActiveStories(username: string, env: Env): Promise<InstagramStories> {
  requireUsername(username)

  // A hosted Instagram API keeps its own sessions/proxies: it is the only
  // source that works when there is no usable cookie and Workers are blocked.
  // It is also billed and rate-limited, so a failure must not be final when a
  // session cookie (or sidecar) can still answer: fall through on error.
  let apiError: Error | undefined
  if (instagramApi(env)) {
    try {
      const stories = await apiStories(username, env)
      return { username, items: stories.items, updatedAt: stories.updatedAt }
    } catch (error) {
      apiError = error as Error
    }
  }

  const helper = await sidecarStoriesResult(username, env)
  if (helper.result) return helper.result
  if (helper.error && !env.IG_COOKIE) throw helper.error

  if (!env.IG_COOKIE) {
    if (apiError) throw apiError
    requireSession(env, 'Stories')
  }
  const userId = await resolveUserId(username, env)

  let reel: any
  try {
    // 1. Modern Web GraphQL query (PolarisStoriesV3ReelPageStandaloneQuery)
    const payload = await queryInstagramGraphQL<any>({
      friendlyName: 'PolarisStoriesV3ReelPageStandaloneQuery',
      docId: '29341065465524437',
      variables: {
        reel_ids_arr: [userId],
        __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true,
      },
      env,
      referer: `https://www.instagram.com/stories/${encodeURIComponent(username)}/`,
    })
    reel = payload?.data?.xdt_api__v1__feed__reels_media?.reels_media?.[0]
  } catch (err) {
    if (String(err).includes('Instagram refused the session')) throw err
    // 2. Fallback to legacy private API
    reel = pickReel(await fetchReel(userId, env), userId)
  }

  const items = reelItems(Array.isArray(reel?.items) ? reel.items : [])
  if (!items.length) {
    if (helper.error) throw helper.error
    await assertSessionForEmpty('stories', env)
  }

  return {
    username,
    items,
    updatedAt: typeof reel?.latest_reel_media === 'number' ? reel.latest_reel_media : undefined,
  }
}

export async function fetchHighlights(username: string, env: Env): Promise<InstagramHighlight[]> {
  requireUsername(username)

  // Hosted API first, but never final: a provider error falls back to the
  // sidecar and the session cookie (same contract as fetchActiveStories).
  let apiError: Error | undefined
  if (instagramApi(env)) {
    try {
      return await apiHighlights(username, env)
    } catch (error) {
      apiError = error as Error
    }
  }

  const helper = await sidecarHighlightsResult(username, env)
  if (helper.result) return helper.result
  if (helper.error && !env.IG_COOKIE) throw helper.error

  if (!env.IG_COOKIE) {
    if (apiError) throw apiError
    requireSession(env, 'Highlights')
  }
  const userId = await resolveUserId(username, env)

  // 1. Modern Web GraphQL query (PolarisProfileStoryHighlightsTrayContentQuery)
  try {
    const payload = await queryInstagramGraphQL<any>({
      friendlyName: 'PolarisProfileStoryHighlightsTrayContentQuery',
      docId: '26970053832668570',
      variables: { user_id: userId },
      env,
      referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
    })

    const edges: any[] = Array.isArray(payload?.data?.highlights?.edges) ? payload.data.highlights.edges : []
    if (edges.length) {
      return edges
        .filter((entry) => entry?.node?.id)
        .map((entry) => ({
          id: String(entry.node.id),
          title: String(entry.node.title || 'Highlight').slice(0, 40),
          count: typeof entry.node.media_count === 'number' ? entry.node.media_count : 0,
        }))
    }
  } catch (err) {
    if (String(err).includes('Instagram refused the session')) throw err
    /* fall back to legacy private API */
  }

  // 2. Fallback: legacy private API
  let payload: any
  try {
    payload = await privateApi<any>(
      `https://i.instagram.com/api/v1/highlights/${encodeURIComponent(userId)}/highlights_tray/`,
      env,
      12_000,
    )
  } catch (err) {
    // Try www.instagram.com
    try {
      payload = await fetchJson<any>(
        `https://www.instagram.com/api/v1/highlights/${encodeURIComponent(userId)}/highlights_tray/`,
        { headers: igWebHeaders(env) },
        12_000,
      )
    } catch {
      throw err
    }
  }
  const tray: any[] = Array.isArray(payload?.tray) ? payload.tray : []
  if (!tray.length) {
    if (helper.error) throw helper.error
    await assertSessionForEmpty('highlights', env)
  }

  return tray
    .filter((entry) => entry?.id)
    .map((entry) => ({
      id: String(entry.id),
      title: String(entry.title || 'Highlight').slice(0, 40),
      count: typeof entry.media_count === 'number' ? entry.media_count : 0,
    }))
}

export async function fetchHighlightItems(
  highlightId: string,
  env: Env,
  username?: string,
): Promise<{ items: MediaItem[]; title?: string }> {
  if (instagramApi(env)) {
    try {
      return await apiHighlightItems(highlightId, env, username)
    } catch {
      /* fall through to the sidecar or the session cookie */
    }
  }

  if (instagramSidecar(env)) {
    try {
      const fromHelper = await sidecarHighlightItems(highlightId, env)
      if (fromHelper.items.length) return fromHelper
    } catch {
      /* fall through to the direct session */
    }
  }

  requireSession(env, 'Highlights')

  const formattedId = highlightId.startsWith('highlight:') ? highlightId : `highlight:${highlightId}`

  // 1. Modern Web GraphQL query (PolarisStoriesV3ReelPageStandaloneQuery)
  try {
    const payload = await queryInstagramGraphQL<any>({
      friendlyName: 'PolarisStoriesV3ReelPageStandaloneQuery',
      docId: '29341065465524437',
      variables: {
        reel_ids_arr: [formattedId],
        __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true,
      },
      env,
      referer: `https://www.instagram.com/stories/highlights/${encodeURIComponent(formattedId.replace('highlight:', ''))}/`,
    })

    const reel = payload?.data?.xdt_api__v1__feed__reels_media?.reels_media?.[0]
    if (reel) {
      return {
        items: reelItems(Array.isArray(reel?.items) ? reel.items : []),
        title: typeof reel?.title === 'string' ? reel.title : undefined,
      }
    }
  } catch (err) {
    if (String(err).includes('Instagram refused the session')) throw err
    /* fall back to legacy private API */
  }

  // 2. Fallback to legacy private API
  const payload = await fetchReel(highlightId, env)
  const reel = pickReel(payload, highlightId)
  return {
    items: reelItems(Array.isArray(reel?.items) ? reel.items : []),
    title: typeof reel?.title === 'string' ? reel.title : undefined,
  }
                 }
