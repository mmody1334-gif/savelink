import { EngineError } from './errors'
import { DESKTOP_UA, IG_APP_UA, MOBILE_UA, decodeEscapes, fetchJson, fetchText } from './http'
import { queryInstagramGraphQL } from './instagram-graphql'
import { apiProfilePhotos, instagramApi } from './instagram-public'
import { isInstagramUsername } from './platforms'
import type { Env, MediaItem } from './types'

const IG_REFERER = 'https://www.instagram.com/'
const IG_WEB_APP_ID = '936619743392459'

/**
 * Resolves the numeric Instagram user id anonymously from the embed page,
 * or falls back to web_profile_info if cookies are present.
 */
export async function resolveUserId(username: string, env: Env): Promise<string> {
  // 1. Anonymous lookup via public embed page
  try {
    const html = await fetchText(
      `https://www.instagram.com/${encodeURIComponent(username)}/embed/`,
      { headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'en-US,en;q=0.9' } },
      12_000,
    )
    const id =
      html.match(/data-owner-id="(\d+)"/)?.[1] ||
      html.match(/owner\\*"\s*:\s*\{\\*"id\\*"\s*:\s*\\*"(\d+)/)?.[1]
    if (id) return id
  } catch {
    /* fall through */
  }

  // 2. Web profile info with session if available
  if (env.IG_COOKIE) {
    try {
      const payload = await fetchJson<any>(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
        {
          headers: igWebHeaders(env),
        },
        12_000,
      )
      const id = payload?.data?.user?.id
      if (id) return String(id)
    } catch {
      /* fall through */
    }
  }

  throw new EngineError(
    `Could not resolve user ID for @${username}. The account may be private or not found.`,
    'instagram-profile',
    false,
  )
}

export interface InstagramProfileInfo {
  username: string
  fullName?: string
  followers?: number
  following?: number
  posts?: number
  avatarUrl: string
  /** true only when a session cookie unlocked profile_pic_url_hd */
  hd: boolean
  recentShortcodes: string[]
  /** signed CDN preview URLs (full resolution), aligned with recentShortcodes */
  recentDisplayUrls: string[]
  videoFlags: boolean[]
}

export interface InstagramProfileResult {
  info: InstagramProfileInfo
  /** avatar first, then the latest media straight from Instagram's signed CDN */
  items: MediaItem[]
  photos: MediaItem[]
  photoCount: number
  videoCount: number
  /** true when the embed exposed fewer media items than the account actually has */
  truncated: boolean
}

function toNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Private mobile API headers (i.instagram.com). Must not contain web app ID. */
export function igHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': IG_APP_UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  }
  if (env.IG_COOKIE) headers.Cookie = env.IG_COOKIE
  return headers
}

/** Web API headers (www.instagram.com). */
export function igWebHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': DESKTOP_UA,
    'x-ig-app-id': IG_WEB_APP_ID,
    'X-Requested-With': 'XMLHttpRequest',
    Referer: IG_REFERER,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  }
  if (env.IG_COOKIE) {
    headers.Cookie = env.IG_COOKIE
    const csrf = env.IG_COOKIE.match(/csrftoken=([^;]+)/)?.[1]
    if (csrf) headers['X-CSRFToken'] = csrf
  }
  return headers
}

function unescapeJsonString(value: string): string {
  return decodeEscapes(value).replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()
}

interface EmbedPost {
  shortcode: string
  displayUrl?: string
  isVideo: boolean
}

/**
 * The public embed page is the only profile endpoint Instagram still serves to
 * anonymous clients. It carries the avatar (150x150) plus the ~6-14 most recent
 * posts, which is exactly the data the DP downloader sites resell.
 */
export async function fetchProfileEmbed(username: string): Promise<InstagramProfileInfo> {
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/embed/`
  let html: string
  try {
    html = await fetchText(
      url,
      { headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'en-US,en;q=0.9' } },
      15_000,
    )
  } catch (error) {
    throw new EngineError(`Instagram embed failed: ${(error as Error).message}`, 'instagram-profile')
  }

  const decoded = decodeEscapes(html)
  const foundUsername = decoded.match(/"username":"([^"]+)"/)?.[1]
  const avatarUrl = decoded.match(/"profile_pic_url":"([^"]+)"/)?.[1]

  if (!foundUsername || !avatarUrl) {
    throw new EngineError(
      'This Instagram profile is private, deleted, or temporarily unavailable.',
      'instagram-profile',
      false,
    )
  }

  const posts = parseEmbedPosts(decoded)

  return {
    username: foundUsername,
    fullName: decoded.match(/"full_name":"((?:[^"\\]|\\.)*)"/)?.[1]
      ? unescapeJsonString(decoded.match(/"full_name":"((?:[^"\\]|\\.)*)"/)![1])
      : undefined,
    followers: toNumber(decoded.match(/"followers_count":(\d+)/)?.[1]),
    following: toNumber(decoded.match(/"following_count":(\d+)/)?.[1]),
    posts: toNumber(decoded.match(/"posts_count":(\d+)/)?.[1]),
    avatarUrl,
    hd: false,
    recentShortcodes: posts.map((post) => post.shortcode),
    recentDisplayUrls: posts.map((post) => post.displayUrl ?? ''),
    videoFlags: posts.map((post) => post.isVideo),
  }
}

/**
 * The embed carries one JSON node per post. Splitting on the shortcode key keeps
 * each display_url next to its own post, so the three arrays never drift apart.
 */
function parseEmbedPosts(decoded: string): EmbedPost[] {
  const posts: EmbedPost[] = []
  const seen = new Set<string>()
  const segments = decoded.split(/"shortcode":"/)

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index]
    const shortcode = segment.match(/^([A-Za-z0-9_-]{5,})/)?.[1]
    if (!shortcode || seen.has(shortcode)) continue
    seen.add(shortcode)
    posts.push({
      shortcode,
      displayUrl: segment.match(/"display_url":"(https:[^"]+)"/)?.[1],
      isVideo: segment.match(/"is_video":(true|false)/)?.[1] === 'true',
    })
  }

  return posts
}

/**
 * With a logged-in session cookie Instagram answers the web/GraphQL API, which
 * provides real post count, followers count, following count, and full HD avatar.
 */
export async function upgradeProfileWithCookie(
  info: InstagramProfileInfo,
  env: Env,
): Promise<InstagramProfileInfo> {
  if (!env.IG_COOKIE) return info

  // 1. Modern Web GraphQL: PolarisProfilePageContentQuery
  try {
    const userId = await resolveUserId(info.username, env)
    const payload = await queryInstagramGraphQL<any>({
      friendlyName: 'PolarisProfilePageContentQuery',
      docId: '40158838120366999',
      variables: {
        enable_integrity_filters: true,
        id: userId,
        __relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider: true,
        __relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider: false,
        __relay_internal__pv__PolarisProfileInformTreatmentBannerEnabledrelayprovider: false,
        __relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider: false,
        __relay_internal__pv__PolarisProfileRingsGradientEnabledrelayprovider: true,
        __relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider: true,
        __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true,
      },
      env,
      referer: `https://www.instagram.com/${encodeURIComponent(info.username)}/`,
    })

    const user = payload?.data?.user
    if (user) {
      const avatarUrl = user.hd_profile_pic_url_info?.url || user.profile_pic_url || info.avatarUrl
      return {
        ...info,
        username: user.username || info.username,
        fullName: user.full_name || info.fullName,
        followers: typeof user.follower_count === 'number' ? user.follower_count : info.followers,
        following: typeof user.following_count === 'number' ? user.following_count : info.following,
        posts: typeof user.media_count === 'number' ? user.media_count : info.posts,
        avatarUrl,
        hd: Boolean(user.hd_profile_pic_url_info?.url),
      }
    }
  } catch {
    /* fall through to legacy handlers */
  }

  // 2. Legacy web_profile_info
  let payload: any = null
  try {
    payload = await fetchJson<any>(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(info.username)}`,
      { headers: igWebHeaders(env) },
      12_000,
    )
  } catch {
    try {
      payload = await fetchJson<any>(
        `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(info.username)}`,
        { headers: igHeaders(env) },
        12_000,
      )
    } catch {
      payload = null
    }
  }

  const user = payload?.data?.user
  if (!user) return info

  const edges = user.edge_owner_to_timeline_media?.edges
  const nodes = Array.isArray(edges) ? edges.map((edge: any) => edge?.node).filter(Boolean) : []
  const shortcodes: string[] = nodes.map((node: any) => node.shortcode).filter(Boolean)
  const displayUrls: string[] = nodes.map((node: any) => node.display_url ?? '')
  const videoFlags: boolean[] = nodes.map((node: any) => Boolean(node.is_video))
  const aligned =
    shortcodes.length > 0 && displayUrls.length === shortcodes.length && videoFlags.length === shortcodes.length

  return {
    ...info,
    username: user.username ?? info.username,
    fullName: user.full_name ?? info.fullName,
    followers: user.edge_followed_by?.count ?? info.followers,
    following: user.edge_follow?.count ?? info.following,
    posts: user.edge_owner_to_timeline_media?.count ?? info.posts,
    avatarUrl: user.profile_pic_url_hd ?? user.profile_pic_url ?? info.avatarUrl,
    hd: Boolean(user.profile_pic_url_hd),
    recentShortcodes: aligned ? shortcodes : info.recentShortcodes,
    recentDisplayUrls: aligned ? displayUrls : info.recentDisplayUrls,
    videoFlags: aligned ? videoFlags : info.videoFlags,
  }
}

/** Cursor stored between "next page" button presses: user id + Instagram after/max_id. */
interface ArchiveCursor {
  userId?: string
  maxId?: string
  after?: string
}

export interface InstagramArchivePage {
  items: MediaItem[]
  /** videos included in this page */
  videoCount: number
  /** opaque cursor for the next page; undefined when the archive ended */
  nextCursor?: string
  /** total posts Instagram reports for the account */
  total?: number
}

async function fetchArchiveGraphQL(
  options: { username: string; env: Env; pageSize?: number },
  cursor?: ArchiveCursor,
): Promise<InstagramArchivePage | null> {
  const after = cursor?.after || cursor?.maxId
  const count = Math.min(50, Math.max(1, options.pageSize ?? 50))
  const variables: Record<string, unknown> = {
    data: {
      count,
      include_relationship_info: true,
      latest_reel_media: true,
    },
    username: options.username,
    __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: true,
    __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true,
    __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider: false,
    __relay_internal__pv__PolarisThreadsStyleCommentsEnabledrelayprovider: false,
    __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
  }
  if (after) {
    variables.after = after
  }

  const payload = await queryInstagramGraphQL<any>({
    friendlyName: 'PolarisProfilePostsQuery',
    docId: '40380470024877440',
    variables,
    env: options.env,
    referer: `https://www.instagram.com/${encodeURIComponent(options.username)}/`,
  })

  const conn = payload?.data?.xdt_api__v1__feed__user_timeline_graphql_connection
  if (!conn || !Array.isArray(conn.edges)) return null

  const edges: any[] = conn.edges
  const items: MediaItem[] = []
  let videoCount = 0

  for (const edge of edges) {
    const node = edge?.node
    if (!node) continue

    if (Array.isArray(node.carousel_media) && node.carousel_media.length > 0) {
      for (const child of node.carousel_media) {
        if (child?.media_type === 2 || (child?.video_versions && child.video_versions.length > 0)) {
          const video = child.video_versions?.[0]
          if (video?.url) {
            items.push({
              kind: 'video',
              url: video.url,
              ext: 'mp4',
              mime: 'video/mp4',
              width: video.width,
              height: video.height,
              referer: IG_REFERER,
            })
            videoCount += 1
          }
        } else {
          const photoUrl = child?.image_versions2?.candidates?.[0]?.url || child?.display_url
          if (photoUrl) items.push(photoItem(photoUrl))
        }
      }
    } else if (node.media_type === 2 || (node.video_versions && node.video_versions.length > 0)) {
      const video = node.video_versions?.[0]
      if (video?.url) {
        items.push({
          kind: 'video',
          url: video.url,
          ext: 'mp4',
          mime: 'video/mp4',
          width: video.width,
          height: video.height,
          referer: IG_REFERER,
        })
        videoCount += 1
      } else if (node.display_url) {
        items.push(photoItem(node.display_url))
      }
    } else {
      const photoUrl = node.image_versions2?.candidates?.[0]?.url || node.display_url
      if (photoUrl) items.push(photoItem(photoUrl))
    }
  }

  const pageInfo = conn.page_info
  const firstUser = edges[0]?.node?.user
  return {
    items,
    videoCount,
    total: typeof firstUser?.edge_owner_to_timeline_media?.count === 'number'
      ? firstUser.edge_owner_to_timeline_media.count
      : undefined,
    nextCursor:
      pageInfo?.has_next_page && pageInfo?.end_cursor
        ? JSON.stringify({
            userId: cursor?.userId || String(firstUser?.pk || firstUser?.id || ''),
            after: String(pageInfo.end_cursor),
            maxId: String(pageInfo.end_cursor),
          })
        : undefined,
  }
}

/**
 * Full-archive browsing with photos and videos.
 * Modern Web GraphQL (PolarisProfilePostsQuery) is primary.
 */
export async function fetchArchivePage(options: {
  username: string
  env: Env
  cursor?: string
  pageSize?: number
}): Promise<InstagramArchivePage> {
  if (!options.env.IG_COOKIE) {
    throw new EngineError(
      'The full archive needs an Instagram session (IG_COOKIE).',
      'instagram-archive',
      false,
    )
  }

  let cursor: ArchiveCursor | undefined
  if (options.cursor) {
    try {
      cursor = JSON.parse(options.cursor) as ArchiveCursor
    } catch {
      cursor = undefined
    }
    if (!cursor?.userId && !cursor?.maxId && !cursor?.after) {
      throw new EngineError('This archive cursor is no longer valid. Send the profile again.', 'instagram-archive', false)
    }
  }

  // 1. Primary: Modern Web GraphQL query with pageSize=50
  try {
    const gql = await fetchArchiveGraphQL(options, cursor)
    if (gql && gql.items.length > 0) return gql
  } catch (gqlErr) {
    if (String(gqlErr).includes('Instagram refused the session')) throw gqlErr
    // If GraphQL failed for network or mock reasons, fall through to legacy handlers
  }

  // 2. Legacy fallback: web_profile_info
  if (!cursor) {
    let user: any = null
    try {
      const payload = await fetchJson<any>(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(options.username)}`,
        { headers: igWebHeaders(options.env) },
        12_000,
      )
      user = payload?.data?.user
    } catch {
      try {
        const payload = await fetchJson<any>(
          `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(options.username)}`,
          { headers: igHeaders(options.env) },
          12_000,
        )
        user = payload?.data?.user
      } catch {
        user = null
      }
    }

    if (user?.edge_owner_to_timeline_media) {
      const media = user.edge_owner_to_timeline_media
      const edges: any[] = Array.isArray(media?.edges) ? media.edges : []
      const items: MediaItem[] = []
      let videoCount = 0
      for (const edge of edges) {
        const node = edge?.node
        if (!node) continue
        if (node.is_video) videoCount += 1
        items.push(...webNodeImages(node))
      }

      const pageInfo = media?.page_info
      return {
        items,
        videoCount,
        total: typeof media?.count === 'number' ? media.count : undefined,
        nextCursor:
          pageInfo?.has_next_page && pageInfo?.end_cursor
            ? JSON.stringify({ userId: String(user.id), maxId: String(pageInfo.end_cursor) })
            : undefined,
      }
    }

    const userId = await resolveUserId(options.username, options.env)
    cursor = { userId }
  }

  const pageSize = Math.min(50, Math.max(1, options.pageSize ?? 50))
  const maxIdParam = cursor.maxId || cursor.after
  const query = `count=${pageSize}${maxIdParam ? `&max_id=${encodeURIComponent(maxIdParam)}` : ''}`
  let payload: any
  try {
    payload = await fetchJson<any>(
      `https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(cursor.userId || '')}/?${query}`,
      { headers: igHeaders(options.env) },
      15_000,
    )
  } catch {
    try {
      payload = await fetchJson<any>(
        `https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(options.username)}/username/?${query}`,
        { headers: igHeaders(options.env) },
        15_000,
      )
    } catch (feedErr) {
      if (!maxIdParam) {
        const embed = await fetchProfileEmbed(options.username)
        const embedPhotos: MediaItem[] = embed.recentDisplayUrls
          .filter((url, i) => url && !embed.videoFlags[i])
          .map((url) => photoItem(url))
        if (embedPhotos.length) {
          return {
            items: embedPhotos,
            videoCount: embed.videoFlags.filter(Boolean).length,
            total: embed.posts,
          }
        }
      }
      throw feedErr
    }
  }

  const raw: any[] = Array.isArray(payload?.items) ? payload.items : []
  const items: MediaItem[] = []
  let videoCount = 0
  for (const item of raw) {
    if (item?.media_type === 2) videoCount += 1
    items.push(...appItemImages(item))
  }

  const nextMaxId = payload?.next_max_id ? String(payload.next_max_id) : ''
  return {
    items,
    videoCount,
    nextCursor:
      payload?.more_available && nextMaxId
        ? JSON.stringify({ userId: cursor.userId, maxId: nextMaxId })
        : undefined,
  }
}

/** web_profile_info node -> full-resolution images (carousel children included). */
function webNodeImages(node: any): MediaItem[] {
  const children = node?.edge_sidecar_to_children?.edges
  if (Array.isArray(children) && children.length) {
    const images: MediaItem[] = []
    for (const edge of children) {
      const child = edge?.node
      if (!child || child.is_video || !child.display_url) continue
      images.push(photoItem(child.display_url))
    }
    return images
  }
  if (node?.is_video || !node?.display_url) return []
  return [photoItem(node.display_url)]
}

/** App feed item -> full-resolution images (carousel_media included). */
function appItemImages(item: any): MediaItem[] {
  const nodes = Array.isArray(item?.carousel_media) && item.carousel_media.length ? item.carousel_media : [item]
  const images: MediaItem[] = []
  for (const node of nodes) {
    if (!node || node.media_type === 2) continue
    const url = node?.image_versions2?.candidates?.[0]?.url
    if (url) images.push(photoItem(url))
  }
  return images
}

function avatarItem(url: string, hd: boolean): MediaItem {
  return {
    kind: 'image',
    url,
    ext: 'jpg',
    mime: 'image/jpeg',
    width: hd ? undefined : 150,
    height: hd ? undefined : 150,
    label: hd ? 'HD' : 'DP',
    referer: IG_REFERER,
  }
}

function photoItem(displayUrl: string): MediaItem {
  return {
    kind: 'image',
    url: displayUrl,
    ext: 'jpg',
    mime: 'image/jpeg',
    referer: IG_REFERER,
  }
}

export interface ProfileOptions {
  username: string
  env: Env
  /** include the recent feed media, not just the avatar */
  withPhotos?: boolean
  /** hard cap from PROFILE_MAX_ITEMS */
  maxItems?: number
}

export async function resolveInstagramProfile(options: ProfileOptions): Promise<InstagramProfileResult> {
  const username = options.username.replace(/^@/, '').trim()
  if (!isInstagramUsername(username)) {
    throw new EngineError('That is not a valid Instagram username.', 'instagram-profile', false)
  }

  // 1. Base info upgraded with GraphQL / cookie
  const embed = await fetchProfileEmbed(username).catch(() => null)
  const baseInfo: InstagramProfileInfo = {
    username,
    fullName: embed?.fullName,
    followers: embed?.followers,
    following: embed?.following,
    posts: embed?.posts,
    avatarUrl: embed?.avatarUrl || '',
    hd: false,
    recentShortcodes: embed?.recentShortcodes ?? [],
    recentDisplayUrls: embed?.recentDisplayUrls ?? [],
    videoFlags: embed?.videoFlags ?? [],
  }

  const info = await upgradeProfileWithCookie(baseInfo, options.env)
  const avatar = avatarItem(info.avatarUrl, info.hd)
  const items: MediaItem[] = [avatar]
  const photos: MediaItem[] = []

  // 2. Fetch full media archive if requested
  let videoCount = 0
  if (options.withPhotos) {
    // Opt-in: the embed only renders a handful of posts, the hosted API returns
    // as many as PROFILE_MAX_ITEMS asks for (billed per returned post).
    if ((options.env.PROFILE_SOURCE || '').toLowerCase() === 'api' && instagramApi(options.env)) {
      try {
        const limit = Math.max(1, options.maxItems ?? 60)
        const mediaList = await apiProfilePhotos(username, options.env, limit)
        if (mediaList.length) {
          return {
            info,
            items: [avatar, ...mediaList],
            photos: mediaList,
            photoCount: mediaList.length,
            videoCount: 0,
            truncated: Boolean(info.posts && info.posts > mediaList.length),
          }
        }
      } catch {
        /* fall back to the embed photos */
      }
    }

    if (options.env.IG_COOKIE) {
      try {
        const page = await fetchArchivePage({
          username,
          env: options.env,
          pageSize: options.maxItems ?? 50,
        })
        if (page.items.length > 0) {
          const mediaList = page.items.slice(0, options.maxItems ?? 100)
          return {
            info,
            items: [avatar, ...mediaList],
            photos: mediaList,
            photoCount: mediaList.length,
            videoCount: page.videoCount,
            truncated: Boolean(info.posts && info.posts > mediaList.length),
          }
        }
      } catch {
        // Fall through to embed photos
      }
    }

    const limit = Math.max(1, options.maxItems ?? 10)
    for (let index = 0; index < info.recentShortcodes.length; index += 1) {
      if (photos.length >= limit) break
      if (info.videoFlags[index]) {
        videoCount += 1
        continue
      }
      const displayUrl = info.recentDisplayUrls[index]
      if (!displayUrl) continue
      const item = photoItem(displayUrl)
      photos.push(item)
      items.push(item)
    }
  } else {
    videoCount = info.videoFlags.filter(Boolean).length
  }

  return {
    info,
    items,
    photos,
    photoCount: photos.length,
    videoCount,
    truncated: Boolean(info.posts && info.posts > info.recentShortcodes.length),
  }
}

export function profileSummaryTitle(info: InstagramProfileInfo): string {
  return info.fullName ? `${info.fullName} (@${info.username})` : `@${info.username}`
}
