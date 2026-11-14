import { EngineError } from '../errors'
import { httpFetch } from '../http'
import type { Engine, MediaItem, MediaResult } from '../types'

interface CobaltResponse {
  status: 'tunnel' | 'redirect' | 'local-processing' | 'picker' | 'error'
  url?: string
  filename?: string
  picker?: Array<{ type: string; url: string; thumb?: string }>
  audio?: string
  audioFilename?: string
  error?: { code?: string; context?: Record<string, unknown> }
}

function extFromName(name: string | undefined, fallback: string): string {
  const match = name?.match(/\.([a-z0-9]{2,5})$/i)
  return match ? match[1].toLowerCase() : fallback
}

function mimeFor(ext: string, kind: MediaItem['kind']): string {
  if (kind === 'audio') return ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg'
  if (kind === 'image') return ext === 'png' ? 'image/png' : 'image/jpeg'
  return 'video/mp4'
}

/**
 * Optional self-hosted cobalt API (https://github.com/imputnet/cobalt).
 * Handy free fallback because cobalt already does server-side MP3 conversion.
 *
 * Do not point this at api.cobalt.tools: the maintainers ask third-party apps
 * to run their own instance.
 */
export const cobaltEngine: Engine = {
  name: 'cobalt',
  available: (env) => Boolean(env.COBALT_INSTANCES?.trim()),
  supports: () => true,
  async resolve(input, env): Promise<MediaResult> {
    const instances = (env.COBALT_INSTANCES ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/\/+$/, ''))
      .filter(Boolean)
    const failures: string[] = []
    const isAudio = input.mode === 'audio'

    for (const instance of instances) {
      try {
        const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' }
        if (env.COBALT_API_KEY) headers.authorization = `Api-Key ${env.COBALT_API_KEY}`

        const response = await httpFetch(
          instance,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              url: input.url,
              downloadMode: isAudio ? 'audio' : 'auto',
              audioFormat: 'mp3',
              audioBitrate: '192',
              videoQuality: input.quality === 'max' ? 'max' : input.quality,
              filenameStyle: 'basic',
            }),
          },
          30_000,
        )

        const payload = (await response.json()) as CobaltResponse
        if (payload.status === 'error') {
          failures.push(`${new URL(instance).hostname}: ${payload.error?.code ?? 'error'}`)
          continue
        }

        const items: MediaItem[] = []
        if (payload.status === 'picker' && payload.picker?.length) {
          for (const entry of payload.picker) {
            if (entry.type === 'photo') {
              items.push({ kind: 'image', url: entry.url, ext: 'jpg', mime: 'image/jpeg' })
            } else {
              items.push({ kind: 'video', url: entry.url, ext: 'mp4', mime: 'video/mp4' })
            }
          }
          if (payload.audio) {
            items.push({ kind: 'audio', url: payload.audio, ext: extFromName(payload.audioFilename, 'mp3'), mime: 'audio/mpeg' })
          }
        } else if (payload.url) {
          const ext = extFromName(payload.filename, isAudio ? 'mp3' : 'mp4')
          const kind: MediaItem['kind'] = isAudio ? 'audio' : 'video'
          items.push({ kind, url: payload.url, ext, mime: mimeFor(ext, kind), label: input.quality === 'max' ? undefined : input.quality })
        }

        if (!items.length) {
          failures.push(`${new URL(instance).hostname}: empty response`)
          continue
        }

        return {
          platform: 'unknown',
          sourceUrl: input.url,
          items,
          engine: 'cobalt',
        }
      } catch (error) {
        failures.push(`${new URL(instance).hostname}: ${(error as Error).message}`)
      }
    }

    throw new EngineError(`cobalt extraction failed (${failures.join('; ')})`, 'cobalt')
  },
}
