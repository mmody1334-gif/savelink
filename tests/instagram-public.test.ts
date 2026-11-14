import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const env = { IG_API_KEY: 'test-key' } as unknown as Env

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('instagram api provider', () => {
  it('maps raw story items (video + photo) and sends the access key', async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input?.url ?? input)
      if (url.includes('/v2/user/stories/by/username')) {
        return respond({
          status: 'ok',
          reel: {
            latest_reel_media: 1775146773,
            items: [
              { media_type: 2, video_versions: [{ url: 'https://cdn/v.mp4', width: 720, height: 1280 }] },
              { media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn/p.jpg', width: 1080, height: 1920 }] } },
            ],
          },
        })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { fetchActiveStories } = await import('../src/instagram-stories')
    const stories = await fetchActiveStories('someone', env)

    expect(stories.updatedAt).toBe(1775146773)
    expect(stories.items).toEqual([
      { kind: 'video', url: 'https://cdn/v.mp4', ext: 'mp4', mime: 'video/mp4', width: 720, height: 1280, referer: 'https://www.instagram.com/' },
      { kind: 'image', url: 'https://cdn/p.jpg', ext: 'jpg', mime: 'image/jpeg', width: 1080, height: 1920, referer: 'https://www.instagram.com/' },
    ])
    const [, init] = fetchMock.mock.calls[0] as any
    expect(init.headers['x-access-key']).toBe('test-key')
  })

  it('reads the highlights tray', async () => {
    // HikerAPI shape (default provider).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond({
          status: 'ok',
          response: { tray: [{ id: 'highlight:1', title: 'Travel', media_count: 4 }] },
        }),
      ),
    )

    const { fetchHighlights } = await import('../src/instagram-stories')

    await expect(fetchHighlights('someone', env)).resolves.toEqual([
      { id: 'highlight:1', title: 'Travel', count: 4 },
    ]) // tray id/title/media_count mapped to id/title/count
  })

  it('uses the Apify actor when IG_PROVIDER=apify and maps its stories', async () => {
    const fetchMock = vi.fn(async (input: any, init: any) => {
      const url = String(input?.url ?? input)
      if (url.includes('/v2/acts/') && url.includes('run-sync-get-dataset-items')) {
        expect(init.method).toBe('POST')
        expect(JSON.parse(init.body).usernames).toEqual(['someone'])
        return respond([
          { status: 'success', activeStories: [{ id: '1', mediaType: 'video', mediaUrl: 'https://cdn/s.mp4', width: 720, height: 1280 }] },
        ])
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { fetchActiveStories } = await import('../src/instagram-stories')
    const apifyEnv = { IG_API_KEY: 'apify-token', IG_PROVIDER: 'apify' } as unknown as Env
    const stories = await fetchActiveStories('someone', apifyEnv)

    expect(stories.items).toHaveLength(1)
    expect(stories.items[0].url).toBe('https://cdn/s.mp4')
    expect(String((fetchMock.mock.calls[0] as any)[0])).toContain('lance_api~instagram-stories-highlights-scraper-api')
  })

  it('reads the selected highlight from the Apify actor output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond([
          {
            status: 'success',
            highlights: [
              { id: 'highlight:7', title: 'Travel', stories: [{ mediaType: 'image', mediaUrl: 'https://cdn/p.jpg' }] },
            ],
          },
        ]),
      ),
    )

    const { fetchHighlightItems } = await import('../src/instagram-stories')
    const apifyEnv = { IG_API_KEY: 'apify-token', IG_PROVIDER: 'apify' } as unknown as Env
    const page = await fetchHighlightItems('highlight:7', apifyEnv, 'someone')

    expect(page.title).toBe('Travel')
    expect(page.items.map((item) => item.url)).toEqual(['https://cdn/p.jpg'])
  })

  it('maps profile posts into photos (carousels expanded, videos skipped)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond([
          { type: 'Image', displayUrl: 'https://cdn/a.jpg', dimensionsWidth: 1080, dimensionsHeight: 1350 },
          { type: 'Video', displayUrl: 'https://cdn/v.mp4' },
          { type: 'Sidecar', images: ['https://cdn/b.jpg', 'https://cdn/c.jpg'] },
        ]),
      ),
    )

    const { apiProfilePhotos } = await import('../src/instagram-public')
    const photos = await apiProfilePhotos('someone', { IG_API_KEY: 'k' } as unknown as Env, 10)

    expect(photos.map((photo) => photo.url)).toEqual(['https://cdn/a.jpg', 'https://cdn/b.jpg', 'https://cdn/c.jpg'])
    expect(photos.every((photo) => photo.kind === 'image')).toBe(true)
  })

  it('reports a provider failure with its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ detail: 'no credits' }, 402)))

    const { fetchHighlights } = await import('../src/instagram-stories')

    await expect(fetchHighlights('someone', env)).rejects.toThrow(/Instagram API \(402\)/)
  })
})
