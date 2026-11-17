import { EngineError } from '../../errors'
import { DESKTOP_UA, MOBILE_UA, decodeEscapes, fetchJson, fetchText } from '../../http'
import { canonicalTikTokUrl } from '../../platforms'
import type { MediaItem, MediaResult, ResolveInput } from '../../types'

const TIKWM = 'https://www.tikwm.com/api/'
const TIKTOK_REFERER = 'https://www.tiktok.com/'

function absolute(value?: string | null): string | undefined {
  if (!value || typeof value !== 'string') return undefined
  if (value.startsWith('http')) return value
  return `https://www.tikwm.com${value.startsWith('/') ? '' : '/'}${value}`
}

function audioItem(url: string | undefined): MediaItem | undefined {
  if (!url) return undefined
  const isM4a = /\.m4a(\?|$)/i.test(url)
  return {
    kind: 'audio',
    url,
    ext: isM4a ? 'm4a' : 'mp3',
    mime: isM4a ? 'audio/mp4' : 'audio/mpeg',
    referer: TIKTOK_REFERER,
    label: 'audio',
  }
}

function fromTikwm(data: any): MediaResult {
  const items: MediaItem[] = []
  const origin: MediaItem['referer'] = TIKTOK_REFERER

  const hd = absolute(data.hdplay)
  const sd = absolute(data.play)
  const watermarked = absolute(data.wmplay)

  if (hd) items.push({ kind: 'video', url: hd, ext: 'mp4', mime: 'video/mp4', height: 1080, label: 'HD', size: Number(data.hd_size) || undefined, referer: origin })
  if (sd) items.push({ kind: 'video', url: sd, ext: 'mp4', mime: 'video/mp4', height: 720, label: 'no-watermark', size: Number(data.size) || undefined, referer: origin })
  if (watermarked && !sd) items.push({ kind: 'video', url: watermarked, ext: 'mp4', mime: 'video/mp4', height: 480, label: 'watermark', referer: origin })

  const music = audioItem(absolute(data.music_info?.play) ?? absolute(data.music))
  if (music) items.push(music)

  if (Array.isArray(data.images)) {
    for (const image of data.images) {
      const url = absolute(typeof image === 'string' ? image : image?.url)
      if (url) items.push({ kind: 'image', url, ext: 'jpg', mime: 'image/jpeg', referer: origin })
    }
  }

  return {
    platform: 'tiktok',
    sourceUrl: '',
    title: data.title || data.music_info?.title || 'TikTok video',
    author: data.author?.nickname || data.author?.unique_id,
    thumbnail: absolute(data.origin_cover) ?? absolute(data.cover),
    duration: Number(data.duration) || undefined,
    items,
    engine: 'tiktok',
  }
}

function fromTikTokHtml(html: string, sourceUrl: string): MediaResult | null {
  const script = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)
  let item: any = null
  if (script) {
    try {
      const parsed = JSON.parse(script[1])
      item = parsed?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct ?? null
    } catch {
      item = null
    }
  }

  if (!item) {
    const raw = decodeEscapes(html)
    const play = raw.match(/"playAddr":"(https:[^"]+)"/)?.[1]
    if (!play) return null
    return {
      platform: 'tiktok',
      sourceUrl,
      title: raw.match(/"desc":"([^"]{1,200})"/)?.[1] ?? 'TikTok video',
      items: [{ kind: 'video', url: play, ext: 'mp4', mime: 'video/mp4', referer: TIKTOK_REFERER }],
      engine: 'tiktok',
    }
  }

  const video = item.video ?? {}
  const items: MediaItem[] = []
  if (video.playAddr) items.push({ kind: 'video', url: video.playAddr, ext: 'mp4', mime: 'video/mp4', height: video.height, width: video.width, referer: TIKTOK_REFERER })
  if (video.downloadAddr) items.push({ kind: 'video', url: video.downloadAddr, ext: 'mp4', mime: 'video/mp4', height: video.height, width: video.width, referer: TIKTOK_REFERER })
  const music = audioItem(video.music?.playUrl ?? item.music?.playUrl)
  if (music) items.push(music)
  if (!items.length) return null

  return {
    platform: 'tiktok',
    sourceUrl,
    title: item.desc || 'TikTok video',
    author: item.author?.nickname || item.author?.uniqueId,
    thumbnail: item.video?.originCover ?? item.video?.cover,
    duration: Number(item.video?.duration) || undefined,
    items,
    engine: 'tiktok',
  }
}

/**
 * tikwm with one retry for transient failures (429/5xx). A 403 from tikwm is
 * a hard IP block (its own Cloudflare front door rejects datacenter IPs, and
 * the Worker is one), so retrying it only burns time — the durable fix for
 * that case is the yt-dlp sidecar, which runs first in ENGINE_ORDER when it
 * is configured. Timeouts are not retried either: one attempt already costs
 * up to 15s.
 */
async function fetchTikwm(url: string): Promise<any> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchJson<any>(
        `${TIKWM}?url=${encodeURIComponent(url)}&hd=1`,
        { headers: { Accept: 'application/json', 'User-Agent': MOBILE_UA } },
        15_000,
      )
    } catch (error) {
      lastError = error as Error
      const status = Number(String(lastError.message).match(/HTTP (\d{3})/)?.[1])
      const retryable = status === 429 || status >= 500
      if (!retryable || attempt === 1) throw lastError
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw lastError ?? new Error('tikwm request failed')
}

export async function extractTikTok(input: ResolveInput): Promise<MediaResult> {
  const url = await canonicalTikTokUrl(input.url)
  const failures: string[] = []

  // 1) tikwm.com - free public API that returns watermark-free MP4 + the original MP3.
  try {
    const payload = await fetchTikwm(url)
    if (payload?.code === 0 && payload?.data) {
      const result = fromTikwm(payload.data)
      result.sourceUrl = url
      if (result.items.length) return result
    }
    failures.push(`tikwm: ${payload?.msg ?? payload?.code ?? 'empty response'}`)
  } catch (error) {
    failures.push(`tikwm: ${(error as Error).message}`)
  }

  // 2) Public page scrape (no watermark guarantees, but a useful backup).
  try {
    const html = await fetchText(
      url,
      { headers: { 'User-Agent': DESKTOP_UA, 'Accept-Language': 'en-US,en;q=0.9' } },
      15_000,
    )
    const result = fromTikTokHtml(html, url)
    if (result) return result
    failures.push('page: playAddr not found')
  } catch (error) {
    failures.push(`page: ${(error as Error).message}`)
  }

  throw new EngineError(`TikTok extraction failed (${failures.join('; ')})`, 'tiktok')
}
