import { describe, expect, it } from 'vitest'
import { hasInstagramStoriesSource } from '../src/telegram/webhook'
import type { Env } from '../src/types'

describe('hasInstagramStoriesSource', () => {
  it('refuses when nothing is configured', () => {
    expect(hasInstagramStoriesSource({} as Env)).toBe(false)
  })

  it('accepts a session cookie', () => {
    expect(hasInstagramStoriesSource({ IG_COOKIE: 'sessionid=x' } as Env)).toBe(true)
  })

  it('accepts the hosted API key without a cookie (the old gate refused this)', () => {
    expect(hasInstagramStoriesSource({ IG_API_KEY: 'k' } as Env)).toBe(true)
    expect(hasInstagramStoriesSource({ IG_API_KEY: 'k', IG_PROVIDER: 'apify' } as Env)).toBe(true)
  })

  it('accepts the sidecar without a cookie', () => {
    expect(hasInstagramStoriesSource({ YTDLP_ENDPOINT: 'https://sidecar.example' } as Env)).toBe(true)
    expect(hasInstagramStoriesSource({ IG_ENDPOINT: 'https://sidecar.example' } as Env)).toBe(true)
  })

  it('ignores a blank API key', () => {
    expect(hasInstagramStoriesSource({ IG_API_KEY: '   ' } as Env)).toBe(false)
  })
})
