import { DESKTOP_UA, httpFetch } from './http'

export interface EromeAlbumSummary {
  id: string
  title: string
  url: string
  thumb?: string
  user?: string
  videosCount?: number
  views?: string
}

export interface EromeVideoItem {
  id: string
  url: string
  thumb?: string
  title?: string
}

export interface EromePhotoItem {
  id: string
  url: string
  thumb?: string
}

export interface EromeAlbumDetail {
  id: string
  title: string
  url: string
  user?: string
  videos: EromeVideoItem[]
  photos: EromePhotoItem[]
}

export interface EromeTarget {
  albumId: string
  url: string
}

export function parseEromeUrl(url: string): EromeTarget | null {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`)
    const host = parsed.hostname.toLowerCase()
    if (!host.endsWith('erome.com')) return null

    const match = parsed.pathname.match(/\/a\/([a-zA-Z0-9]+)/i)
    if (!match) return null

    return {
      albumId: match[1],
      url: `https://www.erome.com/a/${match[1]}`,
    }
  } catch {
    return null
  }
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export async function searchErome(query: string, page = 1): Promise<EromeAlbumSummary[]> {
  const url = `https://www.erome.com/search?q=${encodeURIComponent(query)}&page=${page}`
  const res = await httpFetch(
    url,
    {
      headers: {
        'User-Agent': DESKTOP_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
    10_000,
  )

  if (!res.ok) {
    throw new Error(`Erome search failed with status ${res.status}`)
  }

  const html = await res.text()
  const albums: EromeAlbumSummary[] = []
  
  // Match each album container
  const albumRegex = /<div[^>]*class="[^"]*album[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*album[^"]*"[^>]*>|$)/gi
  const matches = [...html.matchAll(albumRegex)]

  for (const m of matches) {
    const cardHtml = m[0]
    
    // Extract album link and ID
    const linkMatch = cardHtml.match(/href="(?:https?:\/\/(?:www\.)?erome\.com)?\/a\/([a-zA-Z0-9]+)"/i)
    if (!linkMatch) continue
    const id = linkMatch[1]

    // Extract title
    const titleMatch = cardHtml.match(/<a[^>]*class="album-title"[^>]*>([\s\S]*?)<\/a>/i)
    const altTitleMatch = cardHtml.match(/alt="([^"#]+)(?:#[a-zA-Z0-9]+)?"/i)
    const title = decodeHtmlEntities(titleMatch ? titleMatch[1] : (altTitleMatch ? altTitleMatch[1] : `Album ${id}`))

    // Extract thumbnail
    const thumbMatch = cardHtml.match(/src="(https:\/\/[^"]*(?:erome\.com)[^"]*thumbs[^"]*)"/i) ||
                       cardHtml.match(/data-rotate-src="(https:\/\/[^"]*(?:erome\.com)[^"]*thumbs[^"]*)"/i) ||
                       cardHtml.match(/src="(https:\/\/[^"]*(?:erome\.com)[^"]*\.jpg[^"]*)"/i)
    const thumb = thumbMatch ? thumbMatch[1] : undefined

    // Extract user
    const userMatch = cardHtml.match(/<span[^>]*class="album-user"[^>]*>([\s\S]*?)<\/span>/i)
    const user = userMatch ? decodeHtmlEntities(userMatch[1]) : undefined

    // Extract videos count
    const videosMatch = cardHtml.match(/class="album-videos"[^>]*>[\s\S]*?(\d+)[\s\S]*?<\/span>/i)
    const videosCount = videosMatch ? parseInt(videosMatch[1], 10) : undefined

    // Extract views
    const viewsMatch = cardHtml.match(/class="album-bottom-views"[^>]*>[\s\S]*?([0-9.,KMkm]+)[\s\S]*?<\/span>/i)
    const views = viewsMatch ? viewsMatch[1].trim() : undefined

    albums.push({
      id,
      title,
      url: `https://www.erome.com/a/${id}`,
      thumb,
      user,
      videosCount,
      views,
    })
  }

  return albums
}

export async function fetchEromeAlbum(albumId: string): Promise<EromeAlbumDetail> {
  const url = `https://www.erome.com/a/${albumId}`
  const res = await httpFetch(
    url,
    {
      headers: {
        'User-Agent': DESKTOP_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
    12_000,
  )

  if (!res.ok) {
    throw new Error(`Erome album fetch failed with status ${res.status}`)
  }

  const html = await res.text()

  // Extract title
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  const title = decodeHtmlEntities(titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Album ${albumId}`)

  // Extract user
  const userMatch = html.match(/<a[^>]*class="username"[^>]*>([\s\S]*?)<\/a>/i) ||
                    html.match(/<span[^>]*class="album-user"[^>]*>([\s\S]*?)<\/span>/i)
  const user = userMatch ? decodeHtmlEntities(userMatch[1].replace(/<[^>]+>/g, '').trim()) : undefined

  // Extract videos
  const videos: EromeVideoItem[] = []
  const videoMatches = [...html.matchAll(/<video[\s\S]*?<\/video>/gi)]
  
  for (let i = 0; i < videoMatches.length; i++) {
    const vTag = videoMatches[i][0]
    const srcMatch = vTag.match(/<source\s+src="([^"]+)"/i)
    const posterMatch = vTag.match(/poster="([^"]+)"/i)
    
    if (srcMatch && srcMatch[1]) {
      const vidUrl = srcMatch[1]
      const thumb = posterMatch ? posterMatch[1] : undefined
      const idMatch = vidUrl.match(/\/([a-zA-Z0-9_-]+)(?:_\d+p)?\.mp4/i)
      const id = idMatch ? idMatch[1] : `v_${i + 1}`
      
      videos.push({
        id,
        url: vidUrl,
        thumb,
        title: `Video ${i + 1}`,
      })
    }
  }

  // Extract photos
  const photos: EromePhotoItem[] = []
  const photoMatches = [...html.matchAll(/<img[^>]*class="[^"]*img-back[^"]*"[^>]*data-src="([^"]+)"/gi)]
  for (let i = 0; i < photoMatches.length; i++) {
    const photoUrl = photoMatches[i][1]
    photos.push({
      id: `p_${i + 1}`,
      url: photoUrl,
      thumb: photoUrl,
    })
  }

  return {
    id: albumId,
    title,
    url,
    user,
    videos,
    photos,
  }
}
