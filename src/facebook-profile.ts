import { EngineError } from './errors'
import { DESKTOP_UA, decodeEscapes, fetchText } from './http'
import { extractFbDtsg, fetchFacebookHighlightCollections } from './facebook-graphql'
import type { Env, MediaItem } from './types'

const FB_REFERER = 'https://www.facebook.com/'

export interface FacebookProfileInfo {
  username: string
  name: string
  userId?: string
  avatarUrl: string
  hd: boolean
  storyBucketId?: string
  highlightId?: string
  /** every highlight collection id found on the profile, in page order */
  highlightIds?: string[]
  /** fb_dtsg session token lifted from the profile page; lets story/highlight fetches skip the stories shell page */
  dtsg?: string
}

export interface FacebookProfileResult {
  info: FacebookProfileInfo
  items: MediaItem[]
  photos: MediaItem[]
  photoCount: number
}

export function fbHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': DESKTOP_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document',
  }
  if (env.FB_COOKIE) headers.Cookie = env.FB_COOKIE
  return headers
}

export function extractFacebookPhotos(html: string, maxItems = 20, avatarUrl?: string): MediaItem[] {
  const uriRegex = /"(?:uri|src)":\s*"(https:[^"]+)"/g
  const photoMap = new Map<string, { url: string; cstp: string }>()

  const avatarBase = avatarUrl ? avatarUrl.split('?')[0].split('/').pop() || '' : ''

  let match: RegExpExecArray | null
  while ((match = uriRegex.exec(html)) !== null) {
    const raw = match[1].replace(/\\/g, '')
    if (!raw.includes('scontent') || raw.includes('/rsrc.php/') || raw.includes('/m1/v/t6/AQ')) {
      continue
    }

    try {
      const u = new URL(raw)
      const fname = u.pathname.split('/').pop() || ''
      if (!fname || fname === avatarBase) continue

      const cstp = u.searchParams.get('cstp') || ''
      if (!photoMap.has(fname)) {
        photoMap.set(fname, { url: raw, cstp })
      } else if (cstp.includes('mx') && !photoMap.get(fname)!.cstp.includes('mx')) {
        photoMap.set(fname, { url: raw, cstp })
      }
    } catch {
      /* ignore invalid url */
    }
  }

  // Also catch direct scontent URLs matching photo CDN patterns if uri regex didn't catch enough
  if (photoMap.size < 5) {
    const scontentRegex = /https:(?:\\\/\\\/|\/\/)scontent[^"'\s<]+/g
    while ((match = scontentRegex.exec(html)) !== null) {
      const raw = match[0].replace(/\\/g, '').replace(/&amp;/g, '&')
      if (raw.includes('/rsrc.php/') || raw.includes('/m1/v/t6/AQ') || raw.includes('emoji')) continue
      try {
        const u = new URL(raw)
        const fname = u.pathname.split('/').pop() || ''
        if (!fname || fname === avatarBase) continue
        const cstp = u.searchParams.get('cstp') || ''
        if (!photoMap.has(fname)) {
          photoMap.set(fname, { url: raw, cstp })
        }
      } catch {
        /* ignore */
      }
    }
  }

  const items: MediaItem[] = []
  for (const p of photoMap.values()) {
    items.push({
      kind: 'image',
      url: p.url,
      ext: 'jpg',
      mime: 'image/jpeg',
      label: p.cstp || 'Photo',
      referer: FB_REFERER,
    })
    if (items.length >= maxItems) break
  }

  return items
}

export async function resolveFacebookProfile(input: {
  target: string
  env: Env
  maxItems?: number
}): Promise<FacebookProfileResult> {
  const { target, env, maxItems = 20 } = input
  const url = target.startsWith('http') ? target : `https://www.facebook.com/${target}`

  let html: string
  try {
    html = await fetchText(url, { headers: fbHeaders(env) }, 15_000)
  } catch (error) {
    throw new EngineError(
      `Could not load Facebook profile (${(error as Error).message}). Make sure the profile is public.`,
      'facebook-profile',
      false,
    )
  }

  const isRealCheckpoint =
    html.includes('/checkpoint/') ||
    html.includes('"is_checkpointed":true') ||
    html.includes('checkpoint_title') ||
    html.includes('/checkpoint/block')
  if (isRealCheckpoint) {
    throw new EngineError(
      'Facebook session cookie hit a security checkpoint. Please open Facebook in browser to verify account and renew FB_COOKIE.',
      'facebook-profile',
      false,
    )
  }

  if (html.includes('login_attempt') || html.includes('id="login_form"')) {
    // Facebook answered with the login wall. With no cookie that means the
    // profile needs a session; WITH a cookie it means the session was
    // rejected. Scraping the login page would only invent a phantom profile
    // (no avatar, no photos, no highlights), so stop here instead.
    throw new EngineError(
      env.FB_COOKIE
        ? 'Facebook session (FB_COOKIE) expired or was rejected - Facebook returned the login page. Renew FB_COOKIE.'
        : 'Facebook profile requires a login session or is private. Set FB_COOKIE.',
      'facebook-profile',
      false,
    )
  }

  if (html.includes('هذا المحتوى غير متوفر') || html.includes("This content isn't available")) {
    throw new EngineError(
      'Facebook profile is private or locked. The profile may only be visible to friends.',
      'facebook-profile',
      false,
    )
  }

  // 1. User ID & Story Bucket
  const userIdMatches = [
    html.match(/"userID":"(\d+)"/),
    html.match(/"owning_profile":\{"id":"(\d+)"/),
    html.match(/"profile_id":(\d+)/),
    html.match(/"profile_id":"(\d+)"/),
    html.match(/"entity_id":"(\d+)"/),
    html.match(/fb:\/\/profile\/(\d+)/),
    html.match(/[?&]id=(\d+)/),
  ]
  let userId: string | undefined
  for (const m of userIdMatches) {
    if (m && m[1] && m[1] !== '0') {
      userId = m[1]
      break
    }
  }

  const storyBucketMatch = html.match(/"story_bucket":\{"nodes":\[\{[^}]*?"id":"(\d+)"/)
  const storyBucketId = storyBucketMatch?.[1] || userId

  // 2. Full name
  const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i)?.[1]
  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
  let name = ogTitle ? decodeEscapes(ogTitle) : titleTag ? decodeEscapes(titleTag) : ''

  // If title is generic ("Facebook") or empty, look for user's actual name in relay/graphql JSON
  if (!name || name.trim().toLowerCase() === 'facebook') {
    let jsonName = ''
    if (userId) {
      const userWithId =
        html.match(new RegExp(`"id":"${userId}"[^{}]*"name":"([^"]+)"`)) ||
        html.match(new RegExp(`"name":"([^"]+)"[^{}]*"id":"${userId}"`))
      if (userWithId && userWithId[1]) {
        jsonName = userWithId[1]
      }
    }
    if (!jsonName) {
      const anyUser =
        html.match(/"__typename":"User"[^{}]*"name":"([^"]+)"/) ||
        html.match(/"user":\{[^{}]*"name":"([^"]+)"/)
      if (anyUser && anyUser[1]) {
        jsonName = anyUser[1]
      }
    }
    if (jsonName) {
      name = decodeEscapes(jsonName)
    } else {
      const usernameMatch = target.startsWith('http')
        ? (new URL(target).pathname.split('/').filter(Boolean)[0] || target)
        : target
      name = usernameMatch
    }
  }

  // 3. Avatar
  const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/i)?.[1]
  let avatarUrl = ogImage ? decodeEscapes(ogImage) : ''

  // If avatar wasn't found from og:image, fallback to graph api if userId is known
  if (!avatarUrl && userId) {
    avatarUrl = `https://graph.facebook.com/${userId}/picture?width=1080&height=1080`
  }

  if (!avatarUrl) {
    throw new EngineError(
      'Could not find a profile picture for this Facebook profile. The profile may be private.',
      'facebook-profile',
      false,
    )
  }

  const isHd = avatarUrl.includes('mx') || avatarUrl.includes('1080') || avatarUrl.includes('2048')

  // Facebook embeds most profile data as relay JSON in which every URL
  // slash is escaped ("https:\/\/..."), so a highlights shelf link shows up
  // as "\/stories\/highlights\/<id>" and a raw-HTML match misses it. Match
  // on a slash-unescaped copy too, and keep ALL collection ids: a profile
  // can have several highlight collections, not just one.
  const unescapedHtml = html.replace(/\\\//g, '/')
  const highlightIds: string[] = []
  const seenHighlightId = new Set<string>()
  const addHighlightId = (id: string | undefined) => {
    if (id && id !== '0' && !seenHighlightId.has(id)) {
      seenHighlightId.add(id)
      highlightIds.push(id)
    }
  }
  for (const m of unescapedHtml.matchAll(/\/stories\/highlights\/(\d+)/g)) addHighlightId(m[1])
  for (const m of html.matchAll(/"highlight_id":"(\d+)"/g)) addHighlightId(m[1])
  for (const m of html.matchAll(/"collection_id":"(\d+)"/g)) addHighlightId(m[1])

  // The highlights shelf no longer ships in the server-rendered profile HTML;
  // the web app loads it through a deferred GraphQL tile query. When the HTML
  // gives us nothing, replay that query with the session cookie so highlight
  // collections are still discovered.
  const dtsg = extractFbDtsg(html)
  if (!highlightIds.length && userId && env.FB_COOKIE) {
    try {
      if (dtsg) {
        const collections = await fetchFacebookHighlightCollections(userId, dtsg, env)
        for (const c of collections) addHighlightId(c.id)
      }
    } catch (error) {
      // discovery fallback must never break the profile flow
      console.warn('[fb] highlight discovery failed:', (error as Error).message)
    }
  }
  const highlightId = highlightIds[0]

  const photos = extractFacebookPhotos(html, maxItems, avatarUrl)

  const avatarItem: MediaItem = {
    kind: 'image',
    url: avatarUrl,
    ext: 'jpg',
    mime: 'image/jpeg',
    label: isHd ? 'Profile picture · HD' : 'Profile picture',
    referer: FB_REFERER,
  }

  return {
    info: {
      username: target.startsWith('http') ? (new URL(target).pathname.split('/').filter(Boolean)[0] || target) : target,
      name,
      userId,
      avatarUrl,
      hd: isHd,
      storyBucketId,
      highlightId,
      highlightIds,
      dtsg,
    },
    items: [avatarItem, ...photos],
    photos,
    photoCount: photos.length,
  }
}
