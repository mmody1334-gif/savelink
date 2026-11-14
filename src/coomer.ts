import { DESKTOP_UA, httpFetch } from './http'
import type { MediaItem } from './types'

export interface CoomerFile {
  name?: string
  path?: string
}

export interface CoomerPost {
  id: string
  user: string
  service: string
  title?: string
  content?: string
  published?: string
  file?: CoomerFile
  attachments?: CoomerFile[]
}

export interface CoomerMediaVideo {
  id: string
  title: string
  published?: string
  videoUrl: string
  videoPath?: string
  thumbnailUrl?: string
  filename: string
  postUrl?: string
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm'])
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

export function isVideoFile(pathOrName?: string): boolean {
  if (!pathOrName) return false
  const lower = pathOrName.toLowerCase()
  for (const ext of VIDEO_EXTENSIONS) {
    if (lower.endsWith(ext) || lower.includes(`${ext}?`)) return true
  }
  return false
}

export function isImageFile(pathOrName?: string): boolean {
  if (!pathOrName) return false
  const lower = pathOrName.toLowerCase()
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext) || lower.includes(`${ext}?`)) return true
  }
  return false
}

export function murmur2(str: string, seed = 0): number {
  let l = str.length
  let c = seed ^ l
  let d = 0
  let f = 0

  while (l >= 4) {
    f =
      (str.charCodeAt(d) & 255) |
      ((str.charCodeAt(++d) & 255) << 8) |
      ((str.charCodeAt(++d) & 255) << 16) |
      ((str.charCodeAt(++d) & 255) << 24)

    f = (f & 65535) * 1540483477 + ((((f >>> 16) * 1540483477) & 65535) << 16)
    f ^= f >>> 24
    f = (f & 65535) * 1540483477 + ((((f >>> 16) * 1540483477) & 65535) << 16)

    c = ((c & 65535) * 1540483477 + ((((c >>> 16) * 1540483477) & 65535) << 16)) ^ f

    l -= 4
    ++d
  }

  if (l === 3) {
    c ^= (str.charCodeAt(d + 2) & 255) << 16
    c ^= (str.charCodeAt(d + 1) & 255) << 8
    c ^= str.charCodeAt(d) & 255
    c = (c & 65535) * 1540483477 + ((((c >>> 16) * 1540483477) & 65535) << 16)
  } else if (l === 2) {
    c ^= (str.charCodeAt(d + 1) & 255) << 8
    c ^= str.charCodeAt(d) & 255
    c = (c & 65535) * 1540483477 + ((((c >>> 16) * 1540483477) & 65535) << 16)
  } else if (l === 1) {
    c ^= str.charCodeAt(d) & 255
    c = (c & 65535) * 1540483477 + ((((c >>> 16) * 1540483477) & 65535) << 16)
  }

  c ^= c >>> 13
  c = (c & 65535) * 1540483477 + ((((c >>> 16) * 1540483477) & 65535) << 16)
  c ^= c >>> 15

  return c >>> 0
}

export function getCoomerNode(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  const full = `/data${cleanPath}`
  const h = murmur2(full)
  if (h < 1073741823) return 'https://n1.coomer.st'
  if (h < 2147483647) return 'https://n2.coomer.st'
  if (h < 3221225471) return 'https://n3.coomer.st'
  return 'https://n4.coomer.st'
}

export function buildCoomerCdnUrls(domain: string, path: string): string[] {
  if (/^https?:\/\//i.test(path)) return [path]
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  if (domain.includes('coomer')) {
    const node = getCoomerNode(cleanPath)
    return [
      `${node}/data${cleanPath}`,
      `https://coomer.st/data${cleanPath}`,
    ]
  }
  return [`https://${domain}/data${cleanPath}`]
}

export function buildCoomerCdnUrl(domain: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  if (domain.includes('coomer')) {
    const node = getCoomerNode(cleanPath)
    return `${node}/data${cleanPath}`
  }
  return `https://${domain}/data${cleanPath}`
}

export function buildCoomerThumbUrl(domain: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `https://${domain}/thumbnail/data${cleanPath}`
}

export async function fetchCoomerPosts(
  domain: string,
  service: string,
  creatorId: string,
  offset = 0,
): Promise<CoomerPost[]> {
  const primaryDomain = domain || 'coomer.st'
  const fallbackDomain = primaryDomain.includes('kemono') ? 'kemono.su' : 'coomer.su'
  const domains = [primaryDomain]
  if (fallbackDomain !== primaryDomain) domains.push(fallbackDomain)

  for (const host of domains) {
    try {
      const url = `https://${host}/api/v1/${service}/user/${creatorId}/posts?o=${offset}`
      const res = await httpFetch(
        url,
        {
          headers: {
            accept: 'text/css',
            'user-agent': DESKTOP_UA,
          },
        },
        15_000,
      )
      if (res.ok) {
        const data = (await res.json()) as any
        if (Array.isArray(data)) return data
      }
    } catch {
      // try next domain
    }
  }

  return []
}

export async function fetchCoomerSinglePost(
  domain: string,
  service: string,
  creatorId: string,
  postId: string,
): Promise<CoomerPost | null> {
  const primaryDomain = domain || 'coomer.st'
  const fallbackDomain = primaryDomain.includes('kemono') ? 'kemono.su' : 'coomer.su'
  const domains = [primaryDomain]
  if (fallbackDomain !== primaryDomain) domains.push(fallbackDomain)

  for (const host of domains) {
    try {
      const url = `https://${host}/api/v1/${service}/user/${creatorId}/post/${postId}`
      const res = await httpFetch(
        url,
        {
          headers: {
            accept: 'text/css',
            'user-agent': DESKTOP_UA,
          },
        },
        15_000,
      )
      if (res.ok) {
        const data = (await res.json()) as any
        if (data && (data.id || data.post)) return data.post ?? data
      }
    } catch {
      // try next domain
    }
  }

  return null
}

export function extractVideosFromPosts(posts: CoomerPost[], domain: string): CoomerMediaVideo[] {
  const videos: CoomerMediaVideo[] = []

  for (const post of posts) {
    let postThumb: string | undefined

    if (post.file?.path && isImageFile(post.file.path || post.file.name)) {
      postThumb = buildCoomerThumbUrl(domain, post.file.path)
    }
    if (!postThumb && Array.isArray(post.attachments)) {
      const img = post.attachments.find((a) => isImageFile(a.path || a.name))
      if (img?.path) {
        postThumb = buildCoomerThumbUrl(domain, img.path)
      }
    }

    const allFiles: CoomerFile[] = []
    if (post.file?.path && isVideoFile(post.file.path || post.file.name)) {
      allFiles.push(post.file)
    }
    if (Array.isArray(post.attachments)) {
      for (const a of post.attachments) {
        if (a.path && isVideoFile(a.path || a.name)) {
          allFiles.push(a)
        }
      }
    }

    for (const f of allFiles) {
      if (!f.path) continue
      const videoUrl = buildCoomerCdnUrl(domain, f.path)
      const filename = f.name || f.path.split('/').pop() || `${post.id}.mp4`
      const title = post.title?.trim() || post.content?.trim()?.slice(0, 60) || filename

      videos.push({
        id: post.id,
        title,
        published: post.published,
        videoUrl,
        videoPath: f.path,
        thumbnailUrl: postThumb || buildCoomerThumbUrl(domain, f.path),
        filename,
      })
    }
  }

  return videos
}

export function postToMediaItems(post: CoomerPost, domain: string): MediaItem[] {
  const items: MediaItem[] = []

  const files: CoomerFile[] = []
  if (post.file?.path) files.push(post.file)
  if (Array.isArray(post.attachments)) {
    for (const a of post.attachments) {
      if (a.path) files.push(a)
    }
  }

  for (const f of files) {
    if (!f.path) continue
    const isVid = isVideoFile(f.path || f.name)
    const isImg = isImageFile(f.path || f.name)
    const kind = isVid ? 'video' : isImg ? 'image' : 'video'
    const ext = f.name?.split('.').pop()?.toLowerCase() || (isVid ? 'mp4' : 'jpg')
    const mime = isVid ? 'video/mp4' : isImg ? 'image/jpeg' : 'application/octet-stream'

    items.push({
      kind,
      url: buildCoomerCdnUrl(domain, f.path),
      ext,
      mime,
      label: f.name || (isVid ? 'Video' : 'Photo'),
    })
  }

  return items
}

export function cleanHtmlTitle(raw?: string): string {
  if (!raw) return ''
  const decoded = raw
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#43;/g, '+')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return typeof (decoded as any).toWellFormed === 'function' ? (decoded as any).toWellFormed() : decoded
}

export interface CoomerFansProfileResult {
  title: string
  creatorId: string
  service: string
  avatarUrl?: string
  posts: Array<{
    id: string
    title: string
    date?: string
    url: string
  }>
  hasNextPage: boolean
}

export async function fetchCoomerFansPosts(
  service: string,
  creatorId: string,
  username?: string,
  page = 1,
): Promise<CoomerFansProfileResult | null> {
  const userSegment = username ? `${creatorId}/${username}` : creatorId
  const url = `https://coomerfans.com/u/${service}/${userSegment}${page > 1 ? `?page=${page}` : ''}`
  try {
    const res = await httpFetch(url, { headers: { 'user-agent': DESKTOP_UA } }, 15_000)
    if (!res.ok) return null
    const html = await res.text()

    const modelMatch = html.match(/<article class="text-block model-info">([\s\S]*?)<\/article>/i)
    const avatarUrl = modelMatch?.[1]?.match(/<img[^>]+src="([^"]+)"/i)?.[1]
    const title = modelMatch?.[1]?.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.trim() || username || creatorId

    const postMatches = [...html.matchAll(/<div class="post">([\s\S]*?)<\/div>/g)]
    const posts: Array<{ id: string; title: string; date?: string; url: string }> = []

    for (const pm of postMatches) {
      const block = pm[1]
      const linkMatch = block.match(/href="(\/p\/[^\"]+)"/)
      const postTitleMatch = block.match(/<h3><a[^>]*>([\s\S]*?)<\/a><\/h3>/i)
      const dateMatch = block.match(/<span class="post-date">([\s\S]*?)<\/span>/i)

      if (linkMatch) {
        const postUrl = linkMatch[1]
        const idMatch = postUrl.match(/\/p\/([0-9a-zA-Z_-]+)/)
        const id = idMatch ? idMatch[1] : postUrl
        const rawTitle = postTitleMatch ? postTitleMatch[1].trim() : `Post ${id}`
        posts.push({
          id,
          title: cleanHtmlTitle(rawTitle),
          date: dateMatch ? dateMatch[1].trim() : undefined,
          url: postUrl,
        })
      }
    }

    const hasNextPage = html.includes('class="next"')

    return {
      title,
      creatorId,
      service,
      avatarUrl,
      posts,
      hasNextPage,
    }
  } catch {
    return null
  }
}

export interface CoomerFansPostResult {
  id: string
  title: string
  date?: string
  videos: string[]
  images: string[]
}

export async function fetchCoomerFansPost(
  postId: string,
  creatorId?: string,
  service?: string,
): Promise<CoomerFansPostResult | null> {
  const path = creatorId && service ? `/p/${postId}/${creatorId}/${service}` : `/p/${postId}/`
  const url = `https://coomerfans.com${path}`

  try {
    const res = await httpFetch(url, { headers: { 'user-agent': DESKTOP_UA } }, 15_000)
    if (!res.ok) return null
    const html = await res.text()

    const rawTitle = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').trim() || `Post ${postId}`
    const title = cleanHtmlTitle(rawTitle)
    const date = html.match(/<span class="post-date">([\s\S]*?)<\/span>/i)?.[1]?.trim()
    const postBody = html.match(/<div class="post-body">([\s\S]*?)<\/div>/i)?.[1] || html

    const videos: string[] = []
    const videoMatches = [...postBody.matchAll(/<source[^>]+src="([^"]+)"/gi)]
    for (const m of videoMatches) {
      videos.push(m[1].replace(/&amp;/g, '&'))
    }
    const videoTags = [...postBody.matchAll(/<video[^>]+src="([^"]+)"/gi)]
    for (const m of videoTags) {
      videos.push(m[1].replace(/&amp;/g, '&'))
    }

    const images: string[] = []
    const imgMatches = [...postBody.matchAll(/<img[^>]+src="([^"]+)"/gi)]
    for (const m of imgMatches) {
      const src = m[1].replace(/&amp;/g, '&')
      if (src.includes('/storage/') || src.includes('/istorage/')) {
        images.push(src)
      }
    }

    return {
      id: postId,
      title,
      date,
      videos: [...new Set(videos)],
      images: [...new Set(images)],
    }
  } catch {
    return null
  }
}
