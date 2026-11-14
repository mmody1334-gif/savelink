import { EngineError } from '../errors'
import { detectPlatform } from '../platforms'
import type { Engine, Env, MediaResult, Platform, ResolveInput } from '../types'
import { extractFacebook } from './native/facebook'
import { extractInstagram } from './native/instagram'
import { extractPinterest } from './native/pinterest'
import { extractTikTok } from './native/tiktok'
import { extractYouTube } from './native/youtube'
import { extractCoomer } from './native/coomer'
import { extractErome } from './native/erome'
import { extractBunkr } from './native/bunkr'
import { cobaltEngine } from './cobalt'
import { ytdlpEngine } from './ytdlp'

const nativeEngine: Engine = {
  name: 'native',
  available: () => true,
  supports: (platform: Platform) => platform !== 'unknown',
  async resolve(input: ResolveInput, env: Env): Promise<MediaResult> {
    switch (detectPlatform(input.url)) {
      case 'tiktok':
        return await extractTikTok(input)
      case 'instagram':
        return await extractInstagram(input, env)
      case 'facebook':
        return await extractFacebook(input, env)
      case 'pinterest':
        return await extractPinterest(input, env)
      case 'youtube':
        return await extractYouTube(input, env)
      case 'coomer':
        return await extractCoomer(input, env)
      case 'erome':
        return await extractErome(input, env)
      case 'bunkr':
        return await extractBunkr(input, env)
      default:
        throw new EngineError('unsupported platform', 'native', false)
    }
  },
}

export const ENGINES: Record<string, Engine> = {
  native: nativeEngine,
  ytdlp: ytdlpEngine,
  cobalt: cobaltEngine,
}
