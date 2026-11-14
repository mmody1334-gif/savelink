import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'

const storyItem = {
  kind: 'video',
  url: 'https://cdn.example/story.mp4',
  ext: 'mp4',
  mime: 'video/mp4',
  referer: 'https://www.instagram.com/',
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const helperEnv = { IG_ENDPOINT: 'https://helper.test', IG_TOKEN: 'secret' } as unknown as Env

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('instagram sidecar', () => {
  it('serves stories from the helper without touching Instagram directly', async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input?.url ?? input)
      if (url.startsWith('https://helper.test/ig/stories')) {
        return respond({ username: 'someone', updatedAt: 1700000000, items: [storyItem] })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { fetchActiveStories } = await import('../src/instagram-stories')
    const stories = await fetchActiveStories('someone', helperEnv)

    expect(stories.items).toEqual([storyItem])
    expect(stories.updatedAt).toBe(1700000000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as any
    expect(init.headers.authorization).toBe('Bearer secret')
  })

  it('surfaces the helper error when Instagram has no session configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond({ detail: 'Instagram refused the session (login wall).' }, 401)),
    )

    const { fetchActiveStories } = await import('../src/instagram-stories')

    await expect(fetchActiveStories('someone', helperEnv)).rejects.toThrow(/helper \(401\).*login wall/i)
  })

  it('falls back to the direct session when the helper has no items', async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input?.url ?? input)
      if (url.startsWith('https://helper.test/ig/highlights')) return respond({ highlights: [] })
      if (url.includes('/embed/')) return new Response('<div data-owner-id="99"></div>')
      if (url.includes('/accounts/current_user')) return respond({ status: 'ok', user: { pk: 1 } })
      if (url.includes('/api/graphql')) return respond({ data: { highlights: { edges: [] } } })
      if (url.includes('/highlights_tray')) return respond({ tray: [] })
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { fetchHighlights } = await import('../src/instagram-stories')
    const env = { ...helperEnv, IG_COOKIE: 'sessionid=x; ds_user_id=1; csrftoken=y' } as unknown as Env

    await expect(fetchHighlights('someone', env)).resolves.toEqual([])
  })
})
