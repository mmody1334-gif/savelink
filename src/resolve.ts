import { engineOrder } from './config'
import { ENGINES } from './engines'
import { ResolveError, errorMessage } from './errors'
import { detectPlatform, normalizeUrl } from './platforms'
import { sha256Hex } from './sign'
import type { Store } from './store'
import type { Env, MediaResult, Platform, ResolveInput } from './types'

const CACHE_TTL_SECONDS = 300

/**
 * Tries each enabled engine in ENGINE_ORDER until one returns media.
 * A slow or broken engine never blocks the others for longer than its own timeout.
 */
export async function resolveMedia(input: ResolveInput, env: Env, store?: Store): Promise<MediaResult> {
  const url = normalizeUrl(input.url)
  const platform = detectPlatform(url)
  if (platform === 'unknown') {
    throw new ResolveError(
      'unsupported_url',
      'That link is not from TikTok, Instagram, Facebook, Pinterest or YouTube.',
      'Only public posts/reels/videos/pins/playlists are supported.',
    )
  }

  const cacheKey = store ? `r:${await sha256Hex(`${url}|${input.mode}|${input.quality}`)}` : null
  if (store && cacheKey) {
    const cached = await store.get(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached) as MediaResult
      } catch {
        /* corrupted cache entry, ignore */
      }
    }
  }

  const failures: string[] = []
  for (const name of engineOrder(env)) {
    const engine = ENGINES[name]
    if (!engine || !engine.available(env) || !engine.supports(platform)) continue
    try {
      const result = await engine.resolve({ ...input, url }, env)
      if (!result.items.length) {
        failures.push(`${name}: returned no media`)
        continue
      }
      const finalResult: MediaResult = {
        ...result,
        platform,
        sourceUrl: url,
        engine: engine.name,
        warnings: failures.length ? failures.slice(-3) : undefined,
      }
      if (store && cacheKey) await store.put(cacheKey, JSON.stringify(finalResult), CACHE_TTL_SECONDS)
      return finalResult
    } catch (error) {
      failures.push(`${name}: ${errorMessage(error)}`)
    }
  }

  throw new ResolveError(
    'all_engines_failed',
    'No engine could extract this link.',
    failures.slice(-4).join(' | ') || 'No extraction engine is configured.',
  )
}

export function availableEngines(env: Env, platform: Platform = 'tiktok'): string[] {
  return Object.values(ENGINES)
    .filter((engine) => engine.available(env) && engine.supports(platform))
    .map((engine) => engine.name)
}
