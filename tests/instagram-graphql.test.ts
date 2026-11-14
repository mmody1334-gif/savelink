import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearDtsgCache, getFbDtsg, queryInstagramGraphQL } from '../src/instagram-graphql'
import { fetchArchivePage } from '../src/instagram-profile'
import {
  fetchActiveStories,
  fetchHighlightItems,
  fetchHighlights,
} from '../src/instagram-stories'
import type { Env } from '../src/types'

const SESSION: Env = { IG_COOKIE: 'sessionid=abc; ds_user_id=123; csrftoken=csrf_test' }

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as Response

afterEach(() => {
  clearDtsgCache()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Instagram GraphQL helper', () => {
  it('extracts and caches fb_dtsg token from Instagram home page', async () => {
    const spy = vi.fn(async () =>
      jsonResponse('<html><script>["DTSGInitialData",[],{"token":"TEST_DTSG_123"}]</script></html>'),
    )
    vi.stubGlobal('fetch', spy)

    const token = await getFbDtsg(SESSION)
    expect(token).toBe('TEST_DTSG_123')

    // Second call should use cache and not fetch again
    const token2 = await getFbDtsg(SESSION)
    expect(token2).toBe('TEST_DTSG_123')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('queries GraphQL endpoint with proper headers and form body', async () => {
    const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://www.instagram.com/') {
        return jsonResponse('name="fb_dtsg" value="TEST_DTSG_XYZ"')
      }
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('fb_api_req_friendly_name')).toBe('TestQuery')
      expect(body.get('doc_id')).toBe('12345')
      expect(body.get('fb_dtsg')).toBe('TEST_DTSG_XYZ')
      return jsonResponse({ data: { test: true } })
    })
    vi.stubGlobal('fetch', spy)

    const res = await queryInstagramGraphQL<{ data: { test: boolean } }>({
      friendlyName: 'TestQuery',
      docId: '12345',
      variables: { foo: 'bar' },
      env: SESSION,
    })

    expect(res.data.test).toBe(true)
  })
})

describe('Instagram Stories & Highlights via GraphQL', () => {
  it('fetches active stories including video stories', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://www.instagram.com/') {
        return jsonResponse('name="fb_dtsg" value="DTSG_VAL"')
      }
      if (url.includes('/embed/')) {
        return jsonResponse('data-owner-id="152977"')
      }
      return jsonResponse({
        data: {
          xdt_api__v1__feed__reels_media: {
            reels_media: [
              {
                id: '152977',
                latest_reel_media: 1700000000,
                items: [
                  {
                    id: 'story_video',
                    media_type: 2,
                    video_versions: [{ url: 'https://cdn/story.mp4', width: 720, height: 1280 }],
                  },
                ],
              },
            ],
          },
        },
      })
    })

    const stories = await fetchActiveStories('shrouk', SESSION)
    expect(stories.items).toHaveLength(1)
    expect(stories.items[0]).toMatchObject({
      kind: 'video',
      url: 'https://cdn/story.mp4',
      ext: 'mp4',
      mime: 'video/mp4',
    })
  })

  it('fetches highlights tray via GraphQL', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://www.instagram.com/') {
        return jsonResponse('name="fb_dtsg" value="DTSG_VAL"')
      }
      if (url.includes('/embed/')) {
        return jsonResponse('data-owner-id="152977"')
      }
      return jsonResponse({
        data: {
          highlights: {
            edges: [
              { node: { id: 'highlight:123', title: 'My Trip', media_count: 5 } },
              { node: { id: 'highlight:456', title: 'Work', media_count: 8 } },
            ],
          },
        },
      })
    })

    const highlights = await fetchHighlights('shrouk', SESSION)
    expect(highlights).toEqual([
      { id: 'highlight:123', title: 'My Trip', count: 5 },
      { id: 'highlight:456', title: 'Work', count: 8 },
    ])
  })

  it('fetches highlight items including videos and photos', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://www.instagram.com/') {
        return jsonResponse('name="fb_dtsg" value="DTSG_VAL"')
      }
      return jsonResponse({
        data: {
          xdt_api__v1__feed__reels_media: {
            reels_media: [
              {
                id: 'highlight:123',
                title: 'My Trip',
                items: [
                  {
                    id: 'item_1',
                    media_type: 1,
                    image_versions2: { candidates: [{ url: 'https://cdn/trip.jpg' }] },
                  },
                  {
                    id: 'item_2',
                    media_type: 2,
                    video_versions: [{ url: 'https://cdn/trip.mp4' }],
                  },
                ],
              },
            ],
          },
        },
      })
    })

    const result = await fetchHighlightItems('highlight:123', SESSION)
    expect(result.title).toBe('My Trip')
    expect(result.items).toHaveLength(2)
    expect(result.items[0]?.kind).toBe('image')
    expect(result.items[1]?.kind).toBe('video')
  })

  it('fetches archive page including videos and carousels via GraphQL', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://www.instagram.com/') {
        return jsonResponse('name="fb_dtsg" value="DTSG_VAL"')
      }
      return jsonResponse({
        data: {
          xdt_api__v1__feed__user_timeline_graphql_connection: {
            page_info: { has_next_page: true, end_cursor: 'CURSOR_ABC' },
            edges: [
              {
                node: {
                  id: 'post_video',
                  media_type: 2,
                  video_versions: [{ url: 'https://cdn/post_video.mp4' }],
                  user: { pk: '152977', edge_owner_to_timeline_media: { count: 42 } },
                },
              },
              {
                node: {
                  id: 'post_carousel',
                  media_type: 8,
                  carousel_media: [
                    { media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn/c1.jpg' }] } },
                    { media_type: 2, video_versions: [{ url: 'https://cdn/c2.mp4' }] },
                  ],
                },
              },
            ],
          },
        },
      })
    })

    const page = await fetchArchivePage({
      username: 'shrouk',
      env: SESSION,
      cursor: JSON.stringify({ after: 'START' }),
    })

    expect(page.items).toHaveLength(3)
    expect(page.items.map((i) => i.kind)).toEqual(['video', 'image', 'video'])
    expect(page.videoCount).toBe(2)
    expect(page.total).toBe(42)
    expect(JSON.parse(page.nextCursor ?? '{}').after).toBe('CURSOR_ABC')
  })
})
