import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractTikTok } from '../src/engines/native/tiktok'
import type { ResolveInput } from '../src/types'

const INPUT: ResolveInput = {
  url: 'https://www.tiktok.com/@someone/video/1234567890123456789',
  mode: 'video',
  quality: 'max',
}

const TIKWM_OK = {
  code: 0,
  data: {
    play: 'https://cdn.example.com/play.mp4',
    hdplay: 'https://cdn.example.com/hd.mp4',
    title: 'Test video',
    author: { nickname: 'someone' },
    duration: 12,
    music: 'https://cdn.example.com/music.mp3',
  },
}

function stubFetch(handler: (url: string) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => handler(String(input)))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('extractTikTok tikwm retry', () => {
  it('succeeds on the first attempt without retrying', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes('tikwm.com')) {
        return new Response(JSON.stringify(TIKWM_OK), { status: 200 })
      }
      return new Response('<html></html>', { status: 200 })
    })

    const result = await extractTikTok(INPUT)
    expect(result.engine).toBe('tiktok')
    expect(result.items.some((item) => item.kind === 'video')).toBe(true)
    expect(result.items.some((item) => item.kind === 'audio')).toBe(true)
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('tikwm.com'))).toHaveLength(1)
  })

  it('retries once on a transient 429 and then succeeds', async () => {
    let tikwmCalls = 0
    stubFetch((url) => {
      if (url.includes('tikwm.com')) {
        tikwmCalls += 1
        if (tikwmCalls === 1) return new Response('rate limited', { status: 429 })
        return new Response(JSON.stringify(TIKWM_OK), { status: 200 })
      }
      return new Response('<html></html>', { status: 200 })
    })

    const result = await extractTikTok(INPUT)
    expect(result.items.length).toBeGreaterThan(0)
    expect(tikwmCalls).toBe(2)
  })

  it('does not retry a 403: it is a hard IP block, not a transient failure', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes('tikwm.com')) return new Response('Forbidden', { status: 403 })
      return new Response('<html></html>', { status: 200 })
    })

    await expect(extractTikTok(INPUT)).rejects.toThrow(/TikTok extraction failed.*tikwm: HTTP 403/)
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('tikwm.com'))).toHaveLength(1)
  })
})
