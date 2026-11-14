import { EngineError } from '../../errors'
import { DESKTOP_UA, decodeEscapes, fetchText, resolveFinalUrl } from '../../http'
import { isPinterestShortLink, pinterestPinId } from '../../platforms'
import type { Env, MediaItem, MediaResult, ResolveInput } from '../../types'

const PIN_REFERER = 'https://www.pinterest.com/'

function heightFromUrl(url: string): number | undefined {
  const match = url.match(/\/(\d{3,4})p\//) ?? url.match(/_(\d{3,4})w\.mp4/)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

function meta(html: string, property: string): string | undefined {
  const direct = html.match(new RegExp(`<meta[^>]+(?:property|name)="${property}"[^>]+content="([^"]*)"`, 'i'))
  if (direct) return decodeEscapes(direct[1])
  const reversed = html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${property}"`, 'i'))
  return reversed ? decodeEscapes(reversed[1]) : undefined
}

export async function extractPinterest(input: ResolveInput, env: Env): Promise<MediaResult> {
  let url = input.url
  if (isPinterestShortLink(url)) {
    try {
      url = await resolveFinalUrl(url, { headers: { 'User-Agent': DESKTOP_UA } }, 10_000)
    } catch {
      /* keep original */
    }
  }

  const pinId = pinterestPinId(url)
  const target = pinId ? `https://www.pinterest.com/pin/${pinId}/` : url

  const headers: Record<string, string> = {
    'User-Agent': DESKTOP_UA,
    'Accept-Language': 'en-US,en;q=0.9',
  }
  if (env.PINTEREST_COOKIE) headers.Cookie = env.PINTEREST_COOKIE

  try {
    const html = await fetchText(target, { headers }, 20_000)
    const decoded = decodeEscapes(html)

    const found = new Set<string>()
    for (const match of decoded.matchAll(/https:\/\/v\d?\.pinimg\.com\/videos\/[^"'\s\\]+?\.mp4/g)) {
      found.add(match[0])
    }
    // Some pins expose hls only; leave those to the yt-dlp engine.
    if (!found.size) {
      throw new EngineError(
        'Pinterest returned no MP4 streams (the pin may be image-only, HLS-only, or require PINTEREST_COOKIE).',
        'pinterest',
      )
    }

    const items: MediaItem[] = [...found]
      .map<MediaItem>((videoUrl) => {
        // video_list entries look like {"url":"...","width":1080,"height":1920,"duration":21348}
        const context = decoded.slice(decoded.indexOf(videoUrl), decoded.indexOf(videoUrl) + 320)
        const dimensions = context.match(/"width":(\d+),"height":(\d+)/)
        const duration = context.match(/"duration":(\d+)/)
        return {
          kind: 'video',
          url: videoUrl,
          ext: 'mp4',
          mime: 'video/mp4',
          width: dimensions ? Number(dimensions[1]) : undefined,
          height: dimensions ? Number(dimensions[2]) : heightFromUrl(videoUrl),
          label: duration ? `${Math.round(Number(duration[1]) / 1000)}s` : undefined,
          referer: PIN_REFERER,
        }
      })
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))

    return {
      platform: 'pinterest',
      sourceUrl: input.url,
      title: meta(html, 'og:title') ?? 'Pinterest video',
      author: decoded.match(/"full_name":"([^"]+)"/)?.[1],
      thumbnail: meta(html, 'og:image'),
      items,
      engine: 'pinterest',
    }
  } catch (error) {
    if (error instanceof EngineError) throw error
    throw new EngineError(`Pinterest extraction failed: ${(error as Error).message}`, 'pinterest')
  }
}
