import { EngineError } from './errors'
import type { Env, MediaItem } from './types'

export interface PublicHighlight {
  id: string
  title: string
  count: number
}

type Provider = 'hikerapi' | 'apify'

interface Target {
  provider: Provider
  base: string
  key: string
  actor: string
}

/**
 * Story-saver style websites (storysaver.net, storiesig, imginn…) sit behind a
 * Cloudflare Turnstile captcha, so a Worker cannot use them. A hosted API keeps
 * its own sessions and proxies, which is exactly what the bot cannot do on
 * Cloudflare's IPs.
 *
 *   IG_PROVIDER=apify     -> Apify actor (free plan: $5 of usage every month)
 *   IG_PROVIDER=hikerapi  -> HikerAPI REST (default; 100 free requests)
 */
export function instagramApi(env: Env): Target | null {
  const key = (env.IG_API_KEY || '').trim()
  if (!key) return null
  const provider: Provider = (env.IG_PROVIDER || '').trim().toLowerCase() === 'apify' ? 'apify' : 'hikerapi'
  const fallbackBase = provider === 'apify' ? 'https://api.apify.com' : 'https://api.hikerapi.com'
  return {
    provider,
    base: (env.IG_API_BASE || fallbackBase).trim().replace(/\/+$/, ''),
    key,
    actor: (env.IG_APIFY_ACTOR || 'lance_api~instagram-stories-highlights-scraper-api').trim(),
  }
}

async function request<T>(url: string, init: RequestInit, label: string, timeoutMs = 60000): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new EngineError(`Instagram API unreachable: ${(error as Error).message}`, label)
  }

  const text = await response.text()
  if (!response.ok) {
    throw new EngineError(`Instagram API (${response.status}): ${text.slice(0, 160)}`, label)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new EngineError('Instagram API returned invalid JSON.', label)
  }
}

async function hiker<T>(path: string, env: Env): Promise<T> {
  const target = instagramApi(env)
  if (!target) throw new EngineError('The Instagram API provider is not configured.', 'instagram-api', false)
  return await request<T>(
    `${target.base}${path}`,
    { headers: { accept: 'application/json', 'x-access-key': target.key } },
    'instagram-api',
    25_000,
  )
}

async function apifyRun(env: Env, input: Record<string, unknown>): Promise<any[]> {
  const target = instagramApi(env)
  if (!target) throw new EngineError('The Instagram API provider is not configured.', 'instagram-api', false)
  const url = `${target.base}/v2/acts/${target.actor}/run-sync-get-dataset-items?token=${encodeURIComponent(target.key)}`
  const items = await request<any[]>(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
    },
    'instagram-apify',
    120_000,
  )
  return Array.isArray(items) ? items : []
}

/** Normalises a raw Instagram item or a flattened provider item into MediaItem. */
export function publicItem(raw: any): MediaItem | null {
  if (!raw || typeof raw !== 'object') return null

  const video = raw.video_versions?.[0]
  const videoUrl = video?.url || raw.videoUrl || raw.video_url || (raw.mediaType === 'video' || raw.media_type === 2 ? raw.mediaUrl || raw.media_url : undefined)
  if (videoUrl) {
    return {
      kind: 'video',
      url: String(videoUrl),
      ext: 'mp4',
      mime: 'video/mp4',
      width: video?.width ?? raw.width,
      height: video?.height ?? raw.height,
      referer: 'https://www.instagram.com/',
    }
  }

  const candidate = raw.image_versions2?.candidates?.[0]
  const imageUrl =
    candidate?.url || raw.imageUrl || raw.thumbnail_url || raw.display_url || raw.image_url || raw.thumbnailUrl || raw.mediaUrl
  if (imageUrl) {
    return {
      kind: 'image',
      url: String(imageUrl),
      ext: 'jpg',
      mime: 'image/jpeg',
      width: candidate?.width ?? raw.width,
      height: candidate?.height ?? raw.height,
      referer: 'https://www.instagram.com/',
    }
  }
  return null
}

function itemsFrom(raw: any): MediaItem[] {
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.stories) ? raw.stories : []
  return list
    .map((entry: any) => publicItem(entry))
    .filter((item: MediaItem | null): item is MediaItem => Boolean(item))
}

export async function apiStories(
  username: string,
  env: Env,
): Promise<{ items: MediaItem[]; updatedAt?: number }> {
  if (instagramApi(env)?.provider === 'apify') {
    const rows = await apifyRun(env, {
      usernames: [username],
      includeStories: true,
      includeHighlights: false,
      expandHighlightItems: false,
    })
    const row: any = rows[0] ?? {}
    if (row.status === 'error' || row.isAccessible === false) {
      throw new EngineError(`Instagram API: ${row.reason || 'profile not accessible'}`, 'instagram-apify')
    }
    return { items: itemsFrom(row.activeStories ?? row.stories) }
  }

  const payload = await hiker<any>(`/v2/user/stories/by/username?username=${encodeURIComponent(username)}`, env)
  const reel = payload?.reel ?? payload?.response?.reel ?? payload?.response ?? payload
  return {
    items: itemsFrom(reel?.items ?? reel),
    updatedAt: typeof reel?.latest_reel_media === 'number' ? reel.latest_reel_media : undefined,
  }
}

export async function apiHighlights(username: string, env: Env): Promise<PublicHighlight[]> {
  if (instagramApi(env)?.provider === 'apify') {
    const rows = await apifyRun(env, {
      usernames: [username],
      includeStories: false,
      includeHighlights: true,
      expandHighlightItems: false,
    })
    const row: any = rows[0] ?? {}
    if (row.status === 'failed' && row.reason) {
      throw new EngineError(`Instagram API: ${row.reason}`, 'instagram-apify')
    }
    const list: any[] = Array.isArray(row.highlights) ? row.highlights : []
    return list
      .map((entry: any) => ({
        id: String(entry.id ?? entry.highlightId ?? ''),
        title: String(entry.title || 'Highlight').slice(0, 40),
        count: Number(entry.mediaCount ?? entry.storyCount ?? entry.itemCount ?? entry.stories?.length ?? 0) || 0,
      }))
      .filter((entry) => entry.id)
  }

  const payload = await hiker<any>(`/v2/user/highlights/by/username?username=${encodeURIComponent(username)}`, env)
  const tray: any[] = payload?.response?.tray ?? payload?.tray ?? []
  return tray
    .filter((entry) => entry?.id)
    .map((entry) => ({
      id: String(entry.id),
      title: String(entry.title || 'Highlight').slice(0, 40),
      count: typeof entry.media_count === 'number' ? entry.media_count : 0,
    }))
}

export interface ApiProfileInfo {
  username: string
  fullName?: string
  followers?: number
  following?: number
  posts?: number
  avatarUrl: string
  /** true only when the provider returned a high-resolution avatar */
  hd: boolean
}

function asCount(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * Profile metadata (avatar + counts) from the hosted Instagram API.
 *
 * HikerAPI: GET /v2/user/by/username. Apify: the instagram-scraper actor with
 * resultsType 'details' — one billed result per profile, and it returns
 * profilePicUrlHD (320x320), which is better than the embed's 150x150 avatar.
 * This is the base-info fallback when the embed page is login-walled from
 * Cloudflare IPs and no IG_COOKIE session is configured.
 */
export async function apiProfileInfo(username: string, env: Env): Promise<ApiProfileInfo> {
  const target = instagramApi(env)
  if (!target) throw new EngineError('The Instagram API provider is not configured.', 'instagram-api', false)

  if (target.provider === 'apify') {
    const actor = (env.IG_APIFY_POSTS_ACTOR || 'apify~instagram-scraper').trim()
    const rows = await request<any[]>(
      `${target.base}/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(target.key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          directUrls: [`https://www.instagram.com/${username.replace(/^@/, '')}/`],
          resultsType: 'details',
          resultsLimit: 1,
        }),
      },
      'instagram-apify',
      120_000,
    )
    const row: any = Array.isArray(rows) ? rows[0] : undefined
    const avatar = row?.profilePicUrlHD || row?.profilePicUrl
    if (!row || !avatar) {
      throw new EngineError('Instagram API: no profile details returned for this account.', 'instagram-apify')
    }
    return {
      username: String(row.username || username),
      fullName: typeof row.fullName === 'string' ? row.fullName : undefined,
      followers: asCount(row.followersCount),
      following: asCount(row.followsCount),
      posts: asCount(row.postsCount),
      avatarUrl: String(avatar),
      hd: Boolean(row.profilePicUrlHD),
    }
  }

  const payload = await hiker<any>(`/v2/user/by/username?username=${encodeURIComponent(username)}`, env)
  const user: any = payload?.response?.user ?? payload?.user ?? payload?.response ?? payload
  const avatar = user?.profile_pic_url_hd || user?.profile_pic_url
  if (!user || typeof user !== 'object' || !avatar) {
    throw new EngineError('Instagram API: no profile details returned for this account.', 'instagram-api')
  }
  return {
    username: String(user.username || username),
    fullName: typeof user.full_name === 'string' ? user.full_name : undefined,
    followers: asCount(user.follower_count),
    following: asCount(user.following_count),
    posts: asCount(user.media_count),
    avatarUrl: String(avatar),
    hd: Boolean(user.profile_pic_url_hd),
  }
}

/**
 * Recent feed photos for a public profile (carousels expanded, videos skipped).
 * Uses Apify's official Instagram scraper: it is billed per returned post, so
 * the caller decides the limit and the feature is opt-in (PROFILE_SOURCE=api).
 */
export async function apiProfilePhotos(username: string, env: Env, limit: number): Promise<MediaItem[]> {
  const target = instagramApi(env)
  if (!target) throw new EngineError('The Instagram API provider is not configured.', 'instagram-api', false)

  const actor = (env.IG_APIFY_POSTS_ACTOR || 'apify~instagram-scraper').trim()
  const rows = await request<any[]>(
    `${target.base}/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(target.key)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        directUrls: [`https://www.instagram.com/${username.replace(/^@/, '')}/`],
        resultsType: 'posts',
        resultsLimit: Math.max(1, limit),
      }),
    },
    'instagram-apify',
    120_000,
  )

  const photos: MediaItem[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (photos.length >= limit) break
    const type = String(row?.type || '')
    if (type === 'Video') continue
    const urls: string[] = Array.isArray(row?.images) && row.images.length ? row.images : row?.displayUrl ? [row.displayUrl] : []
    for (const url of urls) {
      if (photos.length >= limit) break
      photos.push({
        kind: 'image',
        url: String(url),
        ext: 'jpg',
        mime: 'image/jpeg',
        width: row?.dimensionsWidth,
        height: row?.dimensionsHeight,
        referer: 'https://www.instagram.com/',
      })
    }
  }
  return photos
}

export async function apiHighlightItems(
  highlightId: string,
  env: Env,
  username?: string,
): Promise<{ items: MediaItem[]; title?: string }> {
  if (instagramApi(env)?.provider === 'apify') {
    if (!username) {
      throw new EngineError('Re-open the profile and pick the highlight again.', 'instagram-apify', false)
    }
    const rows = await apifyRun(env, {
      usernames: [username],
      includeStories: false,
      includeHighlights: true,
      expandHighlightItems: true,
      maxHighlightsPerUser: 100,
    })
    const row: any = rows[0] ?? {}
    const wanted = highlightId.replace(/^highlight:/, '')
    const list: any[] = Array.isArray(row.highlights) ? row.highlights : []
    const found = list.find((entry: any) => String(entry.id ?? entry.highlightId ?? '').replace(/^highlight:/, '') === wanted)
    if (!found) throw new EngineError('Instagram API: that highlight is no longer available.', 'instagram-apify', false)
    return { items: itemsFrom(found.stories ?? found.items), title: found.title }
  }

  const id = highlightId.replace(/^highlight:/, '')
  const payload = await hiker<any>(`/v2/highlight/by/id?id=${encodeURIComponent(id)}`, env)
  const reel = payload?.response?.reel ?? payload?.reel ?? payload?.response ?? payload
  return {
    items: itemsFrom(reel?.items ?? reel),
    title: typeof reel?.title === 'string' ? reel.title : undefined,
  }
}
