import { EngineError } from '../errors'
import { httpFetch } from '../http'
import type { Engine, MediaItem, MediaResult } from '../types'

interface SidecarItem {
  kind?: MediaItem['kind']
  url: string
  ext?: string
  mime?: string
  width?: number
  height?: number
  size?: number
  label?: string
}

interface SidecarResponse {
  title?: string
  author?: string
  thumbnail?: string
  duration?: number
  items?: SidecarItem[]
  error?: string
}

/**
 * Optional self-hosted yt-dlp service (see sidecar/). This is the only engine
 * that can produce a real MP3 from any source, because it runs ffmpeg.
 */
export const ytdlpEngine: Engine = {
  name: 'ytdlp',
  available: (env) => Boolean(env.YTDLP_ENDPOINT),
  supports: () => true,
  async resolve(input, env): Promise<MediaResult> {
    const base = (env.YTDLP_ENDPOINT ?? '').replace(/\/+$/, '')
    if (!base) throw new EngineError('YTDLP_ENDPOINT is not configured', 'ytdlp', false)

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (env.YTDLP_TOKEN) headers.authorization = `Bearer ${env.YTDLP_TOKEN}`

    const response = await httpFetch(
      `${base}/resolve`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: input.url, mode: input.mode, quality: input.quality }),
      },
      120_000,
    )

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new EngineError(`sidecar HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, 'ytdlp')
    }

    const payload = (await response.json()) as SidecarResponse
    const rawItems = payload.items ?? []
    if (!rawItems.length) throw new EngineError(payload.error ?? 'sidecar returned no media', 'ytdlp')

    const items: MediaItem[] = rawItems.map((item) => ({
      kind: item.kind ?? (input.mode === 'audio' ? 'audio' : 'video'),
      url: item.url.startsWith('http') ? item.url : `${base}${item.url.startsWith('/') ? '' : '/'}${item.url}`,
      ext: item.ext ?? (input.mode === 'audio' ? 'mp3' : 'mp4'),
      mime: item.mime ?? (input.mode === 'audio' ? 'audio/mpeg' : 'video/mp4'),
      width: item.width,
      height: item.height,
      size: item.size,
      label: item.label,
    }))

    return {
      platform: 'unknown',
      sourceUrl: input.url,
      title: payload.title,
      author: payload.author,
      thumbnail: payload.thumbnail,
      duration: payload.duration,
      items,
      engine: 'ytdlp',
    }
  },
}
