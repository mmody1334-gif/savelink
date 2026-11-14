import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'

// resolveUserId reads the public embed first; every other call is stubbed per test.
const EMBED = '<html><div data-owner-id="17941414141"></div></html>'
const LIVE_SESSION = JSON.stringify({ status: 'ok', user: { pk: 42, username: 'me' } })
const DEAD_SESSION = JSON.stringify({ status: 'fail', message: "We're sorry, but something went wrong." })

function respond(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

function stubInstagram(options: { session: string; emptyData: string }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any) => {
      const url = String(input?.url ?? input)
      if (url.includes('/embed/')) return new Response(EMBED, { status: 200 })
      if (url.includes('/api/v1/accounts/current_user')) return respond(options.session)
      if (url.includes('/api/graphql')) return respond(options.emptyData)
      if (url.includes('/api/v1/feed/reels_media')) return respond('{"reels_media":[]}')
      if (url.includes('/highlights_tray')) return respond('{"tray":[]}')
      return respond('{}')
    }),
  )
}

const env = { IG_COOKIE: 'sessionid=fake; ds_user_id=42; csrftoken=abc' } as unknown as Env

// Module-level caches (dtsg, session probe) are reset with the module registry.
beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('instagram stories with an expired session', () => {
  it('reports the dead session instead of an empty story list', async () => {
    stubInstagram({
      session: DEAD_SESSION,
      emptyData: '{"data":{"xdt_api__v1__feed__reels_media":{"reels_media":[]}}}',
    })
    const { fetchActiveStories } = await import('../src/instagram-stories')

    await expect(fetchActiveStories('someone', env)).rejects.toThrow(/IG_COOKIE has expired/)
  })

  it('still answers "no stories" when the session is alive', async () => {
    stubInstagram({
      session: LIVE_SESSION,
      emptyData: '{"data":{"xdt_api__v1__feed__reels_media":{"reels_media":[]}}}',
    })
    const { fetchActiveStories } = await import('../src/instagram-stories')

    await expect(fetchActiveStories('someone', env)).resolves.toEqual({
      username: 'someone',
      items: [],
      updatedAt: undefined,
    })
  })

  it('reports the dead session for an empty highlights tray too', async () => {
    stubInstagram({ session: DEAD_SESSION, emptyData: '{"data":{"highlights":{"edges":[]}}}' })
    const { fetchHighlights } = await import('../src/instagram-stories')

    await expect(fetchHighlights('someone', env)).rejects.toThrow(/IG_COOKIE has expired/)
  })
})
