import { EngineError } from '../../errors'
import { IG_APP_UA, MOBILE_UA, decodeEscapes, fetchJson, fetchText } from '../../http'
import { resolveInstagramTarget, shortcodeToMediaId } from '../../platforms'
import type { Env, MediaItem, MediaResult, ResolveInput } from '../../types'

const IG_REFERER = 'https://www.instagram.com/'

function collect(node: any, items: MediaItem[]): void {
  if (!node) return
  const videos = node.video_versions
  if (Array.isArray(videos) && videos.length) {
    for (const video of videos) {
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
    }
  } else {
    const candidates = node.image_versions2?.candidates
    if (Array.isArray(candidates) && candidates.length) {
      const best = candidates[0]
      items.push({
        kind: 'image',
        url: best.url,
        ext: 'jpg',
        mime: 'image/jpeg',
        width: best.width,
        height: best.height,
        referer: IG_REFERER,
      })
    }
  }
}

function fromApiItem(item: any): MediaResult {
  const items: MediaItem[] = []
  if (Array.isArray(item.carousel_media) && item.carousel_media.length) {
    for (const node of item.carousel_media) collect(node, items)
  } else {
    collect(item, items)
  }
  return {
    platform: 'instagram',
    sourceUrl: '',
    title: item.caption?.text?.slice(0, 300) || `Instagram ${item.media_type === 2 ? 'reel' : 'post'}`,
    author: item.user?.username,
    thumbnail: item.image_versions2?.candidates?.[0]?.url,
    duration: item.video_duration ? Number(item.video_duration) : undefined,
    items,
    engine: 'instagram',
  }
}

function fromEmbedHtml(html: string, sourceUrl: string): MediaResult | null {
  const decoded = decodeEscapes(html)
  const items: MediaItem[] = []
  const seen = new Set<string>()

  for (const match of decoded.matchAll(/"video_url":"(https:[^"]+?)"/g)) {
    const url = match[1]
    if (seen.has(url)) continue
    seen.add(url)
    items.push({ kind: 'video', url, ext: 'mp4', mime: 'video/mp4', referer: IG_REFERER })
  }
  if (!items.length) {
    for (const match of decoded.matchAll(/"display_url":"(https:[^"]+?)"/g)) {
      const url = match[1]
      if (seen.has(url)) continue
      seen.add(url)
      items.push({ kind: 'image', url, ext: 'jpg', mime: 'image/jpeg', referer: IG_REFERER })
    }
  }
  if (!items.length) return null

  const author = decoded.match(/"username":"([^"]+)"/)?.[1]
  const caption = decoded.match(/"caption":"([^"]{1,200})"/)?.[1]?.replace(/\\n/g, ' ')

  return {
    platform: 'instagram',
    sourceUrl,
    title: caption || (author ? `Instagram · @${author}` : 'Instagram post'),
    author,
    items,
    engine: 'instagram',
  }
}

export async function extractInstagram(input: ResolveInput, env: Env): Promise<MediaResult> {
  const target = await resolveInstagramTarget(input.url)
  if (!target) throw new EngineError('Could not parse that Instagram link', 'instagram')

  const mediaId = shortcodeToMediaId(target.shortcode)
  const failures: string[] = []

  const headers: Record<string, string> = {
    'x-ig-app-id': '936619743392459',
    'User-Agent': IG_APP_UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-requested-with': 'XMLHttpRequest',
  }
  if (env.IG_COOKIE) headers.Cookie = env.IG_COOKIE

  if (mediaId) {
    for (const host of ['https://i.instagram.com', 'https://www.instagram.com']) {
      try {
        const payload = await fetchJson<any>(`${host}/api/v1/media/${mediaId}/info/`, { headers }, 12_000)
        const item = payload?.items?.[0]
        if (item) {
          const result = fromApiItem(item)
          if (result.items.length) {
            result.sourceUrl = input.url
            return result
          }
        }
        failures.push(`api(${new URL(host).hostname}): empty`)
      } catch (error) {
        failures.push(`api(${new URL(host).hostname}): ${(error as Error).message}`)
      }
    }
  }

  // Public embed page. Works for many reels without a session cookie.
  try {
    const embedUrl = `https://www.instagram.com/${target.kind}/${target.shortcode}/embed/captioned/`
    const html = await fetchText(
      embedUrl,
      { headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'en-US,en;q=0.9' } },
      15_000,
    )
    const result = fromEmbedHtml(html, input.url)
    if (result) return result
    failures.push('embed: no media in page')
  } catch (error) {
    failures.push(`embed: ${(error as Error).message}`)
  }

  throw new EngineError(
    `Instagram extraction failed (${failures.join('; ')}). Instagram usually requires a logged-in session cookie (IG_COOKIE) or the yt-dlp engine.`,
    'instagram',
  )
}
