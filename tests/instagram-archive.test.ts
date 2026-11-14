import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchArchivePage } from '../src/instagram-profile'
import {
  fetchActiveStories,
  fetchHighlightItems,
  fetchHighlights,
} from '../src/instagram-stories'
import type { Env } from '../src/types'

const SESSION: Env = { IG_COOKIE: 'sessionid=abc; ds_user_id=1; csrftoken=xyz' }

const jsonResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as Response

function mockFetch(handler: (url: string) => unknown) {
  const spy = vi.fn(async (input: RequestInfo | URL) => jsonResponse(handler(String(input))))
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchArchivePage', () => {
  it('refuses to run without a session cookie', async () => {
    await expect(fetchArchivePage({ username: 'natgeo', env: {} })).rejects.toThrow(/IG_COOKIE/)
  })

  it('maps the first profile page and keeps the cursor for the next tap', async () => {
    const spy = mockFetch(() => ({
      data: {
        user: {
          id: '12345',
          edge_owner_to_timeline_media: {
            count: 62,
            edges: [
              { node: { is_video: false, display_url: 'https://cdn/one.jpg' } },
              { node: { is_video: true, display_url: 'https://cdn/video.jpg' } },
              {
                node: {
                  display_url: 'https://cdn/carousel-cover.jpg',
                  edge_sidecar_to_children: {
                    edges: [
                      { node: { is_video: false, display_url: 'https://cdn/a.jpg' } },
                      { node: { is_video: true, display_url: 'https://cdn/b.mp4' } },
                      { node: { is_video: false, display_url: 'https://cdn/c.jpg' } },
                    ],
                  },
                },
              },
            ],
            page_info: { has_next_page: true, end_cursor: 'CURSOR-1' },
          },
        },
      },
    }))

    const page = await fetchArchivePage({ username: 'natgeo', env: SESSION })

    expect(page.items.map((item) => item.url)).toEqual([
      'https://cdn/one.jpg',
      'https://cdn/a.jpg',
      'https://cdn/c.jpg',
    ])
    expect(page.videoCount).toBe(1)
    expect(page.total).toBe(62)
    expect(JSON.parse(page.nextCursor ?? '{}')).toEqual({ userId: '12345', maxId: 'CURSOR-1' })
    expect(spy.mock.calls.some((c) => String(c[0]).includes('web_profile_info'))).toBe(true)
  })

  it('walks older pages through the app feed and sends the cookie header', async () => {
    const spy = mockFetch(() => ({
      more_available: true,
      next_max_id: 'CURSOR-2',
      items: [
        {
          media_type: 1,
          image_versions2: { candidates: [{ url: 'https://cdn/photo.jpg', width: 1080, height: 1080 }] },
        },
        { media_type: 2, video_versions: [{ url: 'https://cdn/video.mp4' }] },
        {
          media_type: 8,
          carousel_media: [
            { media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn/carousel.jpg' }] } },
            { media_type: 2, video_versions: [{ url: 'https://cdn/carousel.mp4' }] },
          ],
        },
      ],
    }))

    const page = await fetchArchivePage({
      username: 'natgeo',
      env: SESSION,
      cursor: JSON.stringify({ userId: '12345', maxId: 'CURSOR-1' }),
    })

    expect(page.items.map((item) => item.url)).toEqual([
      'https://cdn/photo.jpg',
      'https://cdn/carousel.jpg',
    ])
    expect(page.videoCount).toBe(1)
    expect(JSON.parse(page.nextCursor ?? '{}')).toEqual({ userId: '12345', maxId: 'CURSOR-2' })

    const call = spy.mock.calls.find((c) => String(c[0]).includes('/feed/user/12345/')) as unknown as [
      string,
      RequestInit,
    ]
    expect(call).toBeDefined()
    expect(call[0]).toContain('/feed/user/12345/')
    expect(call[0]).toContain('max_id=CURSOR-1')
    expect((call[1].headers as Record<string, string>).Cookie).toBe(SESSION.IG_COOKIE)
  })

  it('rejects a corrupted cursor so the user can resend the profile', async () => {
    await expect(
      fetchArchivePage({ username: 'natgeo', env: SESSION, cursor: 'not-json' }),
    ).rejects.toThrow(/cursor/i)
  })
})

describe('Instagram stories and highlights', () => {
  const profileLookup = () => ({ data: { user: { id: '777' } } })

  it('maps photo and video story items', async () => {
    mockFetch((url) => {
      if (url.includes('web_profile_info')) return profileLookup()
      return {
        reels: {
          '777': {
            latest_reel_media: 1_700_000_000,
            items: [
              { media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn/s1.jpg' }] } },
              { media_type: 2, video_versions: [{ url: 'https://cdn/s2.mp4', width: 720, height: 1280 }] },
            ],
          },
        },
      }
    })

    const stories = await fetchActiveStories('natgeo', SESSION)
    expect(stories.username).toBe('natgeo')
    expect(stories.updatedAt).toBe(1_700_000_000)
    expect(stories.items.map((item) => item.kind)).toEqual(['image', 'video'])
    expect(stories.items[1]?.url).toBe('https://cdn/s2.mp4')
  })

  it('lists highlights from the tray', async () => {
    mockFetch((url) => {
      if (url.includes('web_profile_info')) return profileLookup()
      return {
        tray: [
          { id: 'highlight:1', title: 'Travel', media_count: 4 },
          { id: 'highlight:2', title: '', media_count: 0 },
          { title: 'broken' },
        ],
      }
    })

    const highlights = await fetchHighlights('natgeo', SESSION)
    expect(highlights).toEqual([
      { id: 'highlight:1', title: 'Travel', count: 4 },
      { id: 'highlight:2', title: 'Highlight', count: 0 },
    ])
  })

  it('reads a single highlight reel', async () => {
    mockFetch(() => ({
      reels_media: [
        {
          id: 'highlight:1',
          title: 'Travel',
          items: [{ media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn/h.jpg' }] } }],
        },
      ],
    }))

    const page = await fetchHighlightItems('highlight:1', SESSION)
    expect(page.title).toBe('Travel')
    expect(page.items).toHaveLength(1)
  })

  it('needs a cookie for stories', async () => {
    await expect(fetchActiveStories('natgeo', {})).rejects.toThrow(/IG_COOKIE/)
    await expect(fetchHighlights('natgeo', {})).rejects.toThrow(/IG_COOKIE/)
  })
})
