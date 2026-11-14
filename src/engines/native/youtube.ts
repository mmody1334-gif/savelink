import { EngineError } from '../../errors'
import { DESKTOP_UA, httpFetch } from '../../http'
import { parseYouTubeVideo } from '../../platforms'
import type { Env, MediaItem, MediaResult, ResolveInput } from '../../types'
import { fetchYouTubeVideoDetails } from '../../youtube'

export async function extractYouTube(input: ResolveInput, _env?: Env): Promise<MediaResult> {
  const parsed = parseYouTubeVideo(input.url)
  if (!parsed) {
    throw new EngineError('Invalid YouTube video link', 'native', false)
  }

  const { videoId } = parsed
  const details = await fetchYouTubeVideoDetails(videoId)

  // Fetch player streaming data via Innertube ANDROID_VR client
  let formats: any[] = []
  let adaptive: any[] = []
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
      formats = data.streamingData?.formats ?? []
      adaptive = data.streamingData?.adaptiveFormats ?? []
    }
  } catch (err) {
    // ignore
  }

  const items: MediaItem[] = []
  const isAudio = input.mode === 'audio'

  if (isAudio) {
    // Look for audio formats in adaptiveFormats
    const audioFormats = adaptive.filter(
      (f) => f.url && (f.mimeType?.startsWith('audio/') || f.audioQuality),
    )
    // Sort by bitrate descending
    audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))

    if (audioFormats.length) {
      // Pick best or matching quality
      const chosen = audioFormats[0]
      const isM4a = chosen.mimeType?.includes('audio/mp4') || chosen.mimeType?.includes('m4a')
      items.push({
        kind: 'audio',
        url: chosen.url,
        ext: isM4a ? 'm4a' : 'mp3',
        mime: isM4a ? 'audio/mp4' : 'audio/mpeg',
        size: chosen.contentLength ? parseInt(chosen.contentLength, 10) : undefined,
        label: `${Math.round((chosen.bitrate || 128000) / 1000)}k`,
      })
    }
  } else {
    // Video mode
    // Formats with both audio and video (e.g. itag 18)
    const combinedFormats = formats.filter((f) => f.url && f.mimeType?.startsWith('video/'))

    // Adaptive video formats
    const videoFormats = adaptive.filter((f) => f.url && f.mimeType?.startsWith('video/'))

    // Match requested quality
    let targetFormat: any = null
    const targetQ = input.quality.replace(/p$/, '')

    if (targetQ !== 'max') {
      targetFormat = videoFormats.find((f) => f.qualityLabel?.startsWith(targetQ))
        || combinedFormats.find((f) => f.qualityLabel?.startsWith(targetQ))
    }

    if (!targetFormat) {
      // fallback to combined first (so it has audio), or highest adaptive video
      targetFormat = combinedFormats[0] || videoFormats[0]
    }

    if (targetFormat) {
      items.push({
        kind: 'video',
        url: targetFormat.url,
        ext: 'mp4',
        mime: 'video/mp4',
        width: targetFormat.width,
        height: targetFormat.height,
        size: targetFormat.contentLength ? parseInt(targetFormat.contentLength, 10) : undefined,
        label: targetFormat.qualityLabel,
      })
    }
  }

  if (!items.length) {
    throw new EngineError(
      'Could not extract playable YouTube stream. Use sidecar (yt-dlp) or Cobalt for protected videos.',
      'native',
      false,
    )
  }

  return {
    platform: 'youtube',
    sourceUrl: input.url,
    title: details.title,
    author: details.author,
    thumbnail: details.thumbnail,
    duration: details.duration,
    items,
    engine: 'native',
  }
}
