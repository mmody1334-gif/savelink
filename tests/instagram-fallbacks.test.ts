import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'

function respond(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  })
}

const DTSG_HTML = '<script>["DTSGInitialData",[],{"token":"tok123"}]</script>'
const LOGIN_HTML = '<html><body>login</body></html>'

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

/** Hosted API down; every session path must still answer. */
function mockFallbackFetch(handlers: {
  reelItems?: unknown[]
  tray?: unknown[]
}) {
  return vi.fn(async (input: any) => {
    const url = String(input?.url ?? input)
    if (url.includes('hikerapi.com')) return respond({ error: 'provider down' }, 500)
    if (url.includes('/embed/')) return respond('<a data-owner-id="123"></a>', 200, 'text/html')
    if (url === 'https://www.instagram.com/') return respond(DTSG_HTML, 200, 'text/html')
    if (url.includes('/api/graphql')) return respond(LOGIN_HTML, 200, 'text/html')
    if (url.includes('feed/reels_media')) {
      return respond({ reels: { '123': { items: handlers.reelItems ?? [] } }, status: 'ok' })
    }
    if (url.includes('highlights_tray')) return respond({ tray: handlers.tray ?? [], status: 'ok' })
    throw new Error(`unexpected request: ${url}`)
  })
}

describe('hosted API fallback to the session cookie', () => {
  const env = { IG_API_KEY: 'dead-key', IG_COOKIE: 'sessionid=x' } as unknown as Env

  it('stories fall back to the cookie when the hosted API errors', async () => {
    vi.stubGlobal(
      'fetch',
      mockFallbackFetch({
        reelItems: [
          { media_type: 2, video_versions: [{ url: 'https://cdn/v.mp4', width: 720, height: 1280 }] },
        ],
      }),
    )
    const { fetchActiveStories } = await import('../src/instagram-stories')
    const stories = await fetchActiveStories('someone', env)
    expect(stories.items).toHaveLength(1)
    expect(stories.items[0].url).toBe('https://cdn/v.mp4')
  })

  it('highlights fall back to the cookie when the hosted API errors', async () => {
    vi.stubGlobal('fetch', mockFallbackFetch({ tray: [{ id: 'highlight:9', title: 'Trip', media_count: 3 }] }))
    const { fetchHighlights } = await import('../src/instagram-stories')
    const highlights = await fetchHighlights('someone', env)
    expect(highlights).toEqual([{ id: 'highlight:9', title: 'Trip', count: 3 }])
  })

  it('surfaces the hosted API error when there is no cookie either', async () => {
    vi.stubGlobal('fetch', mockFallbackFetch({}))
    const { fetchHighlights } = await import('../src/instagram-stories')
    const noCookie = { IG_API_KEY: 'dead-key' } as unknown as Env
    await expect(fetchHighlights('someone', noCookie)).rejects.toThrow(/Instagram API \(500\)/)
  })
})

describe('GraphQL login wall detection', () => {
  it('names an HTML answer instead of throwing a bare SyntaxError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const url = String(input?.url ?? input)
        if (url === 'https://www.instagram.com/') return respond(DTSG_HTML, 200, 'text/html')
        return respond(LOGIN_HTML, 200, 'text/html')
      }),
    )
    const { queryInstagramGraphQL } = await import('../src/instagram-graphql')
    await expect(
      queryInstagramGraphQL({
        friendlyName: 'Test',
        docId: '1',
        variables: {},
        env: { IG_COOKIE: 'sessionid=x' } as unknown as Env,
      }),
    ).rejects.toThrow(/login wall/)
  })
})

describe('profile archive pagination', () => {
  it('follows next cursors until the cap is reached', async () => {
    const photo = (n: number) => ({
      image_versions2: { candidates: [{ url: `https://cdn/p${n}.jpg`, width: 100, height: 100 }] },
    })
    const gql = vi.fn(async (_input: any, init?: any) => {
      const vars = JSON.parse(new URLSearchParams(String(init?.body ?? '')).get('variables') ?? '{}')
      if (vars.enable_integrity_filters) {
        return respond({
          data: {
            user: {
              username: 'natgeo',
              hd_profile_pic_url_info: { url: 'https://cdn/avatar.jpg' },
              media_count: 250,
            },
          },
        })
      }
      if (!vars.after) {
        return respond({
          data: {
            xdt_api__v1__feed__user_timeline_graphql_connection: {
              edges: [
                { node: { carousel_media: [photo(1), photo(2)], user: { pk: 1, edge_owner_to_timeline_media: { count: 250 } } } },
                { node: photo(3) },
              ],
              page_info: { has_next_page: true, end_cursor: 'C1' },
            },
          },
        })
      }
      return respond({
        data: {
          xdt_api__v1__feed__user_timeline_graphql_connection: {
            edges: [{ node: photo(4) }],
            page_info: { has_next_page: false },
          },
        },
      })
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any, init?: any) => {
        const url = String(input?.url ?? input)
        if (url.includes('/natgeo/embed/')) {
          // First call: resolveUserId embed (owner id). Profile embed returns a wall.
          return respond('<a data-owner-id="123"></a>', 200, 'text/html')
        }
        if (url === 'https://www.instagram.com/') return respond(DTSG_HTML, 200, 'text/html')
        if (url.includes('/api/graphql')) return gql(input, init)
        throw new Error(`unexpected request: ${url}`)
      }),
    )
    const { resolveInstagramProfile } = await import('../src/instagram-profile')
    const result = await resolveInstagramProfile({
      username: 'natgeo',
      env: { IG_COOKIE: 'sessionid=x' } as unknown as Env,
      withPhotos: true,
      maxItems: 60,
    })
    expect(result.photos.map((p) => p.url)).toEqual([
      'https://cdn/p1.jpg',
      'https://cdn/p2.jpg',
      'https://cdn/p3.jpg',
      'https://cdn/p4.jpg',
    ])
    // The account reports 250 posts and we only sent one page set: truncated.
    expect(result.truncated).toBe(true)
    const archiveCalls = gql.mock.calls.filter(([, init]) =>
      !String((init as any)?.body ?? '').includes('enable_integrity_filters'),
    )
    expect(archiveCalls).toHaveLength(2)
  })
})
