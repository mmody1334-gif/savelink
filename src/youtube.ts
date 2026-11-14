import { DESKTOP_UA, httpFetch } from './http'

export interface YouTubeVideoDetails {
  videoId: string
  title: string
  author: string
  duration?: number
  thumbnail?: string
}

export interface YouTubePlaylistItem {
  videoId: string
  title: string
  author?: string
  thumbnail?: string
  duration?: number
  index?: number
}

export interface YouTubePlaylistResult {
  playlistId: string
  title: string
  author: string
  videoCount: number
  items: YouTubePlaylistItem[]
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Fetches basic video metadata (Title, Author, Duration, Thumbnail).
 * Uses YouTube Innertube ANDROID_VR client first, with fallback to oEmbed.
 */
export async function fetchYouTubeVideoDetails(videoId: string): Promise<YouTubeVideoDetails> {
  try {
    const res = await httpFetch(
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': DESKTOP_UA,
          'x-youtube-client-name': '28',
          'x-youtube-client-version': '1.65.10',
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: 'ANDROID_VR',
              clientVersion: '1.65.10',
              hl: 'en',
              gl: 'US',
            },
          },
        }),
      },
      15_000,
    )

    if (res.ok) {
      const data = (await res.json()) as any
      const details = data?.videoDetails
      if (details?.title) {
        const thumbs = details.thumbnail?.thumbnails ?? []
        const bestThumb = thumbs.length ? thumbs[thumbs.length - 1].url : undefined
        return {
          videoId,
          title: details.title,
          author: details.author || 'YouTube',
          duration: details.lengthSeconds ? parseInt(details.lengthSeconds, 10) : undefined,
          thumbnail: bestThumb || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        }
      }
    }
  } catch {
    // fallback to oEmbed below
  }

  // Fallback: oEmbed
  const oembedRes = await httpFetch(
    `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
    { headers: { 'user-agent': DESKTOP_UA } },
    10_000,
  )
  if (oembedRes.ok) {
    const data = (await oembedRes.json()) as any
    return {
      videoId,
      title: data.title || `Video ${videoId}`,
      author: data.author_name || 'YouTube',
      thumbnail: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    }
  }

  return {
    videoId,
    title: `Video ${videoId}`,
    author: 'YouTube',
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  }
}

/**
 * Parses a YouTube playlist page and returns metadata and the list of video items.
 */
export async function fetchYouTubePlaylist(playlistId: string): Promise<YouTubePlaylistResult> {
  const url = `https://www.youtube.com/playlist?list=${playlistId}`
  const res = await httpFetch(
    url,
    {
      headers: {
        'user-agent': DESKTOP_UA,
        cookie: 'CONSENT=YES+cb',
        'accept-language': 'en-US,en;q=0.9',
      },
    },
    20_000,
  )

  if (!res.ok) {
    throw new Error(`Failed to fetch playlist (HTTP ${res.status})`)
  }

  const html = await res.text()
  const idx = html.indexOf('var ytInitialData = ')
  if (idx === -1) {
    throw new Error('Could not parse playlist metadata')
  }

  const endIdx = html.indexOf(';</script>', idx)
  const jsonStr = endIdx !== -1
    ? html.substring(idx + 'var ytInitialData = '.length, endIdx)
    : html.substring(idx + 'var ytInitialData = '.length)

  let data: any
  try {
    data = JSON.parse(jsonStr)
  } catch (err) {
    throw new Error('Failed to parse YouTube playlist JSON data')
  }

  // Extract playlist title and author
  const meta = data.metadata?.playlistMetadataRenderer
  const title = meta?.title || 'YouTube Playlist'

  // Extract author
  let author = 'YouTube'
  if (data.sidebar?.playlistSidebarRenderer?.items) {
    for (const it of data.sidebar.playlistSidebarRenderer.items) {
      const ownerRuns = it.playlistSidebarSecondaryInfoRenderer?.videoOwner?.videoOwnerRenderer?.title?.runs
      if (ownerRuns?.[0]?.text) {
        author = ownerRuns[0].text
        break
      }
    }
  }

  // Extract video items by recursively searching for lockupViewModel or playlistVideoRenderer
  const items: YouTubePlaylistItem[] = []
  const seen = new Set<string>()

  function walk(node: any) {
    if (!node || typeof node !== 'object') return

    // Modern YouTube lockupViewModel
    if (node.lockupViewModel && node.lockupViewModel.contentId) {
      const l = node.lockupViewModel
      const vid = l.contentId
      if (vid && !seen.has(vid)) {
        seen.add(vid)
        const vTitle = l.metadata?.lockupMetadataViewModel?.title?.content || `Video ${vid}`
        const vAuthor = l.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content
        const thumb = l.contentImage?.thumbnailViewModel?.image?.sources?.[0]?.url
        items.push({
          videoId: vid,
          title: vTitle,
          author: vAuthor || author,
          thumbnail: thumb,
          index: items.length + 1,
        })
      }
      return
    }

    // Classic playlistVideoRenderer
    if (node.playlistVideoRenderer && node.playlistVideoRenderer.videoId) {
      const r = node.playlistVideoRenderer
      const vid = r.videoId
      if (vid && !seen.has(vid)) {
        seen.add(vid)
        const vTitle = r.title?.runs?.[0]?.text || r.title?.simpleText || `Video ${vid}`
        const vAuthor = r.shortBylineText?.runs?.[0]?.text
        const thumb = r.thumbnail?.thumbnails?.[0]?.url
        const dur = r.lengthSeconds ? parseInt(r.lengthSeconds, 10) : undefined
        items.push({
          videoId: vid,
          title: vTitle,
          author: vAuthor || author,
          thumbnail: thumb,
          duration: dur,
          index: items.length + 1,
        })
      }
      return
    }

    for (const key of Object.keys(node)) {
      walk(node[key])
    }
  }

  if (data.contents) {
    walk(data.contents)
  }

  return {
    playlistId,
    title,
    author,
    videoCount: items.length,
    items,
  }
}

export interface YouTubeSearchResult {
  videoId: string
  title: string
  author: string
  duration?: string
  thumbnail?: string
}

export async function searchYouTube(query: string, limit = 15): Promise<YouTubeSearchResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  try {
    const res = await httpFetch(
      'https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': DESKTOP_UA,
        },
        body: JSON.stringify({
          query: trimmed,
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: '2.20230622.01.00',
              hl: 'ar',
              gl: 'EG',
            },
          },
        }),
      },
      10_000,
    )

    if (!res.ok) return []
    const data = (await res.json()) as any
    const contents =
      data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]
        ?.itemSectionRenderer?.contents ?? []

    const results: YouTubeSearchResult[] = []
    for (const item of contents) {
      const v = item.videoRenderer
      if (!v || !v.videoId) continue

      const title =
        v.title?.runs?.map((r: any) => r.text).join('') ||
        v.title?.simpleText ||
        'Video'
      const author =
        v.ownerText?.runs?.map((r: any) => r.text).join('') ||
        v.shortBylineText?.runs?.map((r: any) => r.text).join('') ||
        'YouTube'
      const duration = v.lengthText?.simpleText
      const thumbs = v.thumbnail?.thumbnails ?? []
      const thumb = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`

      results.push({
        videoId: v.videoId,
        title,
        author,
        duration,
        thumbnail: thumb,
      })

      if (results.length >= limit) break
    }

    return results
  } catch {
    return []
  }
}

