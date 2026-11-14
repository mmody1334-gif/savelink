import type { Platform } from './types'
import { resolveFinalUrl, MOBILE_UA } from './http'

const HOST_RULES: Array<{ platform: Exclude<Platform, 'unknown'>; pattern: RegExp }> = [
  { platform: 'tiktok', pattern: /(^|\.)tiktok\.com$/ },
  { platform: 'instagram', pattern: /(^|\.)(instagram\.com|instagr\.am)$/ },
  { platform: 'facebook', pattern: /(^|\.)(facebook\.com|fb\.watch|fb\.me|fb\.com)$/ },
  { platform: 'pinterest', pattern: /(^|\.)(pinterest\.[a-z.]+|pin\.it)$/ },
  { platform: 'youtube', pattern: /(^|\.)(youtube\.com|youtu\.be)$/ },
  { platform: 'coomer', pattern: /(^|\.)(coomer\.(st|su|party)|kemono\.(su|party)|coomerfans\.com)$/ },
  { platform: 'erome', pattern: /(^|\.)erome\.com$/ },
  { platform: 'bunkr', pattern: /(^|\.)(bunkr\.(cr|is|si|black|media|ph|ru|su)|bunkrr\.su)$/ },
]

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function detectPlatform(url: string): Platform {
  const host = hostnameOf(url)
  if (!host) return 'unknown'
  for (const rule of HOST_RULES) {
    if (rule.pattern.test(host)) return rule.platform
  }
  return 'unknown'
}

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|igshid$|mibextid$|_r$|_t$|si$|share_app_id$)/i

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(withScheme)
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key)
    }
    return parsed.toString()
  } catch {
    return withScheme
  }
}

/** Pulls the first URL out of a Telegram message. */
export function findUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s<>"'`]+/i)
  if (!match) return undefined
  return match[0].replace(/[.,;:!?)\]}]+$/, '')
}

const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Instagram shortcode -> numeric media id (base64 variant used by IG). */
export function shortcodeToMediaId(shortcode: string): string {
  let value = 0n
  for (const char of shortcode) {
    const index = SHORTCODE_ALPHABET.indexOf(char)
    if (index < 0) return ''
    value = value * 64n + BigInt(index)
  }
  return value.toString()
}

export interface InstagramTarget {
  shortcode: string
  kind: 'p' | 'reel' | 'tv'
}

export async function resolveInstagramTarget(url: string): Promise<InstagramTarget | null> {
  let target = url
  if (/\/share\//.test(target) || hostnameOf(target) === 'instagr.am') {
    try {
      target = await resolveFinalUrl(target, { headers: { 'User-Agent': MOBILE_UA } }, 10_000)
    } catch {
      return null
    }
  }
  const match = target.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/)
  if (!match) return null
  const kind = match[1] === 'reels' ? 'reel' : (match[1] as 'p' | 'reel' | 'tv')
  return { shortcode: match[2], kind }
}

/** TikTok short links (vm./vt.) redirect to the canonical video URL. */
export async function canonicalTikTokUrl(url: string): Promise<string> {
  const host = hostnameOf(url)
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com' || /\/t\//.test(new URL(url).pathname)) {
    try {
      return await resolveFinalUrl(url, { headers: { 'User-Agent': MOBILE_UA } }, 10_000)
    } catch {
      return url
    }
  }
  return url
}

/**
 * Instagram keeps these first path segments for its own routes. A URL that
 * looks like /username/ but uses one of them is not a profile.
 */
const IG_RESERVED = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'stories',
  'explore',
  'accounts',
  'share',
  'direct',
  'about',
  'legal',
  'developer',
  'challenge',
  'emails',
  'session',
  'web',
  'api',
  'graphql',
  'oauth',
  'press',
  'help',
  'privacy',
  'terms',
  'directory',
  'lite',
  'invites',
  'activity',
  'nametag',
  'topics',
  'reels_audio',
  'audio',
  's',
  'x',
  'ar',
])

export function isInstagramUsername(value: string): boolean {
  return /^[A-Za-z0-9._]{1,30}$/.test(value) && !value.startsWith('.') && !value.endsWith('.')
}

/**
 * Accepts https://instagram.com/<user>/, instagr.am/<user>, or a bare
 * "@user" / "user" token. Returns null for posts, reels, stories, etc.
 */
export function parseInstagramProfile(raw: string): { username: string } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const bare = trimmed.replace(/^@/, '')
  if (isInstagramUsername(bare) && !IG_RESERVED.has(bare.toLowerCase())) {
    return { username: bare }
  }

  let parsed: URL
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (!/(^|\.)(instagram\.com|instagr\.am)$/i.test(parsed.hostname)) return null
  if (parsed.pathname.includes('/share/')) return null

  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length !== 1) return null
  const username = segments[0].replace(/^@/, '')
  if (!isInstagramUsername(username)) return null
  if (IG_RESERVED.has(username.toLowerCase())) return null
  return { username }
}

/** Extracts a profile target from a message or command body. */
export function findInstagramProfile(text: string): { username: string } | null {
  const url = findUrl(text)
  if (url) {
    const profile = parseInstagramProfile(url)
    if (profile) return profile
  }
  const token = text
    .replace(/^@/, '')
    .split(/\s+/)
    .find((part) => isInstagramUsername(part.replace(/^@/, '')))
  if (!token) return null
  return parseInstagramProfile(token)
}

export function pinterestPinId(url: string): string | null {
  const match = url.match(/\/pin\/([A-Za-z0-9_-]+)/)
  return match?.[1] ?? null
}

export function isPinterestShortLink(url: string): boolean {
  return hostnameOf(url) === 'pin.it'
}

export type InstagramStoryTarget =
  | { kind: 'story'; username: string; storyId?: string }
  | { kind: 'highlight'; highlightId: string }

export function parseInstagramStoryLink(raw: string): InstagramStoryTarget | null {
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`)
    if (!/(^|\.)(instagram\.com|instagr\.am)$/i.test(parsed.hostname)) return null

    const highlightMatch = parsed.pathname.match(/\/stories\/highlights\/([0-9A-Za-z_]+)/)
    if (highlightMatch) {
      const rawId = highlightMatch[1]
      return { kind: 'highlight', highlightId: rawId.startsWith('highlight:') ? rawId : `highlight:${rawId}` }
    }

    const storyMatch = parsed.pathname.match(/\/stories\/([A-Za-z0-9._]+)(?:\/(\d+))?/)
    if (storyMatch) {
      const username = storyMatch[1].replace(/^@/, '')
      if (isInstagramUsername(username) && !IG_RESERVED.has(username.toLowerCase())) {
        return { kind: 'story', username, storyId: storyMatch[2] }
      }
    }
  } catch {
    return null
  }
  return null
}

const FB_RESERVED = new Set([
  'plugins',
  'video',
  'watch',
  'reel',
  'reels',
  'share',
  'groups',
  'events',
  'marketplace',
  'gaming',
  'pages',
  'login',
  'recover',
  'help',
  'settings',
  'messages',
  'notifications',
  'saved',
  'bookmarks',
  'ads',
  'business',
  'privacy',
  'policies',
  'terms',
  'photo',
  'photos',
  'stories',
  'photo.php',
  'video.php',
  'watch.php',
  'permalink.php',
])

export interface FacebookProfileTarget {
  kind: 'username' | 'id'
  value: string
  url: string
}

export function parseFacebookProfile(raw: string): FacebookProfileTarget | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (!/(^|\.)(facebook\.com|fb\.com)$/i.test(parsed.hostname)) return null

  // profile.php?id=12345
  if (parsed.pathname === '/profile.php') {
    const id = parsed.searchParams.get('id')
    if (id && /^\d+$/.test(id)) {
      return { kind: 'id', value: id, url: `https://www.facebook.com/profile.php?id=${id}` }
    }
    return null
  }

  // /people/Full-Name/1000123456/
  const peopleMatch = parsed.pathname.match(/^\/people\/[^/]+\/(\d+)/i)
  if (peopleMatch) {
    return { kind: 'id', value: peopleMatch[1], url: `https://www.facebook.com/profile.php?id=${peopleMatch[1]}` }
  }

  // /username/
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length === 1) {
    const seg = segments[0].toLowerCase()
    if (!FB_RESERVED.has(seg) && !/^(photo|photos|stories|reel|reels|watch)$/i.test(seg)) {
      return { kind: 'username', value: segments[0], url: `https://www.facebook.com/${segments[0]}` }
    }
  }

  return null
}

export function findFacebookProfile(text: string): FacebookProfileTarget | null {
  const url = findUrl(text)
  if (url) {
    return parseFacebookProfile(url)
  }
  return null
}

export type FacebookStoryTarget =
  | { kind: 'story'; bucketId: string; storyId?: string }
  | { kind: 'highlight'; highlightId: string }

export function parseFacebookStoryLink(raw: string): FacebookStoryTarget | null {
  let parsed: URL
  try {
    parsed = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`)
  } catch {
    return null
  }
  if (!/(^|\.)(facebook\.com|fb\.com)$/i.test(parsed.hostname)) return null

  const hlMatch = parsed.pathname.match(/\/stories\/highlights\/([0-9A-Za-z_]+)/i)
  if (hlMatch) {
    return { kind: 'highlight', highlightId: hlMatch[1] }
  }
  const hlQuery = parsed.searchParams.get('bucket_id')
  if (/\/stories\/highlights/i.test(parsed.pathname) && hlQuery) {
    return { kind: 'highlight', highlightId: hlQuery }
  }

  const storyMatch = parsed.pathname.match(/\/stories\/([0-9A-Za-z_.]+)(?:\/(\d+))?/i)
  if (storyMatch && storyMatch[1].toLowerCase() !== 'highlights') {
    return { kind: 'story', bucketId: storyMatch[1], storyId: storyMatch[2] }
  }

  return null
}

export function isFacebookPhoto(url: string): boolean {
  try {
    const parsed = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`)
    if (!/(^|\.)(facebook\.com|fb\.com)$/i.test(parsed.hostname)) return false
    if (parsed.pathname === '/photo' || parsed.pathname === '/photo/' || parsed.pathname === '/photo.php') {
      return parsed.searchParams.has('fbid')
    }
    if (/\/photos\//i.test(parsed.pathname)) return true
    return false
  } catch {
    return false
  }
}

export function parseYouTubeVideo(raw: string): { videoId: string } | null {
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`)
    const host = parsed.hostname.toLowerCase()
    if (!/(^|\.)(youtube\.com|youtu\.be)$/i.test(host)) return null

    // youtu.be/<id>
    if (/(^|\.)youtu\.be$/i.test(host)) {
      const id = parsed.pathname.slice(1).split('/')[0]
      if (id && /^[\w-]{11}$/.test(id)) return { videoId: id }
    }

    // /watch?v=<id>
    const vParam = parsed.searchParams.get('v')
    if (vParam && /^[\w-]{11}$/.test(vParam)) return { videoId: vParam }

    // /shorts/<id>, /embed/<id>, /v/<id>, /live/<id>
    const match = parsed.pathname.match(/\/(shorts|embed|v|live)\/([\w-]{11})/i)
    if (match) return { videoId: match[2] }

    return null
  } catch {
    return null
  }
}

export function parseYouTubePlaylist(raw: string): { playlistId: string } | null {
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`)
    const host = parsed.hostname.toLowerCase()
    if (!/(^|\.)(youtube\.com|youtu\.be)$/i.test(host)) return null

    const list = parsed.searchParams.get('list')
    if (list && /^[\w-]{10,}$/.test(list) && list !== 'WL') {
      return { playlistId: list }
    }

    return null
  } catch {
    return null
  }
}

export interface CoomerTarget {
  domain: string
  service: string
  creatorId: string
  username?: string
  postId?: string
  offset?: number
  page?: number
}

export function parseCoomerUrl(raw: string): CoomerTarget | null {
  try {
    const url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`)
    const host = url.hostname.toLowerCase()
    if (!/(^|\.)(coomer\.(st|su|party)|kemono\.(su|party)|coomerfans\.com)$/i.test(host)) return null

    if (host.includes('coomerfans.com')) {
      // Post matches: /p/:postId/:creatorId/:service or /p/:postId
      const postWithService = url.pathname.match(/^\/p\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)/)
      if (postWithService) {
        return {
          domain: host,
          postId: postWithService[1],
          creatorId: postWithService[2],
          service: postWithService[3],
        }
      }
      const postShort = url.pathname.match(/^\/p\/([a-zA-Z0-9_-]+)/)
      if (postShort) {
        return {
          domain: host,
          postId: postShort[1],
          creatorId: '',
          service: '',
        }
      }

      // Creator matches: /u/:service/:creatorId/:username or /u/:service/:creatorId
      const userMatch = url.pathname.match(/^\/u\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)(?:\/([a-zA-Z0-9_.-]+))?/)
      if (userMatch) {
        const pageParam = url.searchParams.get('page')
        const page = pageParam ? parseInt(pageParam, 10) : 1
        return {
          domain: host,
          service: userMatch[1],
          creatorId: userMatch[2],
          username: userMatch[3],
          page: Number.isFinite(page) && page > 0 ? page : 1,
          offset: Number.isFinite(page) && page > 0 ? page : 1,
        }
      }

      return null
    }

    // Match /:service/user/:creator/post/:postId
    const postMatch = url.pathname.match(/^\/([a-zA-Z0-9_-]+)\/user\/([a-zA-Z0-9_.-]+)\/post\/([a-zA-Z0-9_.-]+)/)
    if (postMatch) {
      return {
        domain: host,
        service: postMatch[1],
        creatorId: postMatch[2],
        postId: postMatch[3],
      }
    }

    // Match /:service/user/:creator
    const userMatch = url.pathname.match(/^\/([a-zA-Z0-9_-]+)\/user\/([a-zA-Z0-9_.-]+)/)
    if (userMatch) {
      const o = url.searchParams.get('o')
      const offset = o ? parseInt(o, 10) : 0
      return {
        domain: host,
        service: userMatch[1],
        creatorId: userMatch[2],
        offset: Number.isFinite(offset) ? offset : 0,
      }
    }

    return null
  } catch {
    return null
  }
}

export { parseEromeUrl, type EromeTarget } from './erome'
export { parseBunkrUrl, type BunkrTarget } from './bunkr'


