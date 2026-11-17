import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchProfileEmbed, resolveInstagramProfile } from '../src/instagram-profile'
import { clearDtsgCache } from '../src/instagram-graphql'
import { apiProfileInfo } from '../src/instagram-public'
import type { Env } from '../src/types'

const AVATAR_HD = 'https://scontent.cdninstagram.com/v/hd.jpg'
const AVATAR_150 = 'https://scontent.cdninstagram.com/v/150.jpg'
const PHOTO_ONE = 'https://scontent.cdninstagram.com/v/one.jpg'
const PHOTO_TWO = 'https://scontent.cdninstagram.com/v/two.jpg'

/** The page Instagram serves to datacenter IPs: HTTP 200, but a login wall. */
const LOGIN_WALL_HTML =
  '<html><head><title>Login • Instagram</title></head><body>Log in to continue checkpoint</body></html>'

const SESSION: Env = { IG_COOKIE: 'sessionid=abc; ds_user_id=1; csrftoken=xyz' }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  clearDtsgCache()
})

describe('resolveInstagramProfile fallback chain', () => {
  it('fails honestly when the embed is login-walled and nothing else is configured', async () => {
    stubFetch(() => new Response(LOGIN_WALL_HTML, { status: 200 }))
    await expect(
      resolveInstagramProfile({ username: 'natgeo', env: {} as Env, withPhotos: true, maxItems: 10 }),
    ).rejects.toThrow(/could not be loaded/)
    try {
      await resolveInstagramProfile({ username: 'natgeo', env: {} as Env })
    } catch (error) {
      const message = (error as Error).message
      expect(message).toMatch(/embed page: Instagram served a login page/)
      expect(message).toMatch(/IG_COOKIE/)
      expect(message).toMatch(/IG_API_KEY/)
      // The webhook shows the detailed error (not the generic "not found"
      // card) only when these words are absent from the message.
      expect(message).not.toMatch(/private|unavailable/i)
    }
  })

  it('fails honestly on an embed HTTP error and never returns an empty avatar URL', async () => {
    stubFetch(() => new Response('blocked', { status: 403 }))
    await expect(
      resolveInstagramProfile({ username: 'natgeo', env: {} as Env }),
    ).rejects.toThrow(/embed page: Instagram embed failed: HTTP 403/)
  })

  it('falls back to the session when the embed is login-walled', async () => {
    stubFetch((url) => {
      if (url.includes('/embed/')) return new Response(LOGIN_WALL_HTML, { status: 200 })
      if (url.includes('web_profile_info')) return json({ data: { user: { id: '12345' } } })
      if (url === 'https://www.instagram.com/') {
        return new Response('<html>["DTSGInitialData",[],{"token":"DTSG123"}]</html>', { status: 200 })
      }
      if (url.includes('/api/graphql')) {
        return json({
          data: {
            user: {
              username: 'natgeo',
              full_name: 'National Geographic',
              follower_count: 100,
              following_count: 50,
              media_count: 9,
              hd_profile_pic_url_info: { url: AVATAR_HD },
              profile_pic_url: AVATAR_150,
            },
          },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await resolveInstagramProfile({
      username: 'natgeo',
      env: SESSION,
      withPhotos: true,
      maxItems: 10,
    })

    expect(result.info.avatarUrl).toBe(AVATAR_HD)
    expect(result.info.hd).toBe(true)
    expect(result.info.followers).toBe(100)
    expect(result.items[0].url).toBe(AVATAR_HD)
  })

  it('falls back to the hosted API (hiker) when embed and session are absent', async () => {
    stubFetch((url) => {
      if (url.includes('/embed/')) return new Response(LOGIN_WALL_HTML, { status: 200 })
      if (url.includes('api.hikerapi.com/v2/user/by/username')) {
        return json({
          response: {
            user: {
              username: 'natgeo',
              full_name: 'Nat Geo',
              follower_count: 280000000,
              following_count: 12,
              media_count: 5000,
              profile_pic_url_hd: AVATAR_HD,
              profile_pic_url: AVATAR_150,
            },
          },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await resolveInstagramProfile({
      username: 'natgeo',
      env: { IG_API_KEY: 'k123', IG_PROVIDER: 'hikerapi' } as Env,
    })

    expect(result.info.avatarUrl).toBe(AVATAR_HD)
    expect(result.info.hd).toBe(true)
    expect(result.info.followers).toBe(280000000)
    expect(result.info.posts).toBe(5000)
    expect(result.items[0].url).toBe(AVATAR_HD)
  })

  it('falls back to the hosted API (apify details) when embed is login-walled', async () => {
    stubFetch((url) => {
      if (url.includes('/embed/')) return new Response(LOGIN_WALL_HTML, { status: 200 })
      if (url.includes('run-sync-get-dataset-items')) {
        return json([
          {
            username: 'natgeo',
            fullName: 'National Geographic',
            followersCount: 42,
            followsCount: 7,
            postsCount: 9,
            profilePicUrl: AVATAR_150,
            profilePicUrlHD: AVATAR_HD,
          },
        ])
      }
      return new Response('not found', { status: 404 })
    })

    const result = await resolveInstagramProfile({
      username: 'natgeo',
      env: { IG_API_KEY: 'k123', IG_PROVIDER: 'apify' } as Env,
    })

    expect(result.info.avatarUrl).toBe(AVATAR_HD)
    expect(result.info.hd).toBe(true)
    expect(result.info.followers).toBe(42)
  })

  it('reports truncation when the account has more posts than the embed exposes', async () => {
    const html = [
      '<html><script type="application/json">{',
      '"username":"natgeo","full_name":"National Geographic","posts_count":50,',
      `"profile_pic_url":"${AVATAR_150}",`,
      '"edge_owner_to_timeline_media":{"edges":[',
      `{"node":{"shortcode":"AAA11","display_url":"${PHOTO_ONE}","is_video":false}},`,
      `{"node":{"shortcode":"BBB22","display_url":"${PHOTO_TWO}","is_video":false}}`,
      ']}}',
      '</script></html>',
    ].join('')
    stubFetch(() => new Response(html, { status: 200 }))

    const result = await resolveInstagramProfile({
      username: 'natgeo',
      env: {} as Env,
      withPhotos: true,
      maxItems: 10,
    })

    expect(result.photoCount).toBe(2)
    expect(result.truncated).toBe(true)
  })
})

describe('fetchProfileEmbed display_url fallback', () => {
  it('still finds photos when posts carry no shortcode keys', async () => {
    const html = [
      '<html><script type="application/json">{',
      '"username":"natgeo","full_name":"National Geographic",',
      `"profile_pic_url":"${AVATAR_150}",`,
      '"edge_owner_to_timeline_media":{"edges":[',
      `{"node":{"display_url":"${PHOTO_ONE}","is_video":false}},`,
      `{"node":{"display_url":"${PHOTO_TWO}","is_video":false}}`,
      ']}}',
      '</script></html>',
    ].join('')
    stubFetch(() => new Response(html, { status: 200 }))

    const info = await fetchProfileEmbed('natgeo')
    expect(info.recentDisplayUrls).toEqual([PHOTO_ONE, PHOTO_TWO])

    const result = await resolveInstagramProfile({
      username: 'natgeo',
      env: {} as Env,
      withPhotos: true,
      maxItems: 10,
    })
    expect(result.photos.map((item) => item.url)).toEqual([PHOTO_ONE, PHOTO_TWO])
  })
})

describe('apiProfileInfo', () => {
  it('refuses without a configured provider', async () => {
    await expect(apiProfileInfo('natgeo', {} as Env)).rejects.toThrow(/not configured/)
  })

  it('reads the apify details actor output', async () => {
    stubFetch((url, init) => {
      expect(url).toContain('apify~instagram-scraper')
      expect(String(init?.body)).toContain('"resultsType":"details"')
      return json([
        {
          username: 'natgeo',
          fullName: 'National Geographic',
          followersCount: 42,
          followsCount: 7,
          postsCount: 9,
          profilePicUrl: AVATAR_150,
          profilePicUrlHD: AVATAR_HD,
        },
      ])
    })
    const info = await apiProfileInfo('natgeo', { IG_API_KEY: 'k', IG_PROVIDER: 'apify' } as Env)
    expect(info).toEqual({
      username: 'natgeo',
      fullName: 'National Geographic',
      followers: 42,
      following: 7,
      posts: 9,
      avatarUrl: AVATAR_HD,
      hd: true,
    })
  })

  it('reads the hiker user endpoint', async () => {
    stubFetch((url) => {
      expect(url).toContain('/v2/user/by/username?username=natgeo')
      return json({
        response: {
          user: {
            username: 'natgeo',
            full_name: 'Nat Geo',
            follower_count: 5,
            following_count: 6,
            media_count: 7,
            profile_pic_url: AVATAR_150,
          },
        },
      })
    })
    const info = await apiProfileInfo('natgeo', { IG_API_KEY: 'k', IG_PROVIDER: 'hikerapi' } as Env)
    expect(info.avatarUrl).toBe(AVATAR_150)
    expect(info.hd).toBe(false)
    expect(info.followers).toBe(5)
  })
})
