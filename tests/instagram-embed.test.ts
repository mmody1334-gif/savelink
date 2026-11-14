import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchProfileEmbed, resolveInstagramProfile } from '../src/instagram-profile'
import type { Env } from '../src/types'

const AVATAR = 'https://scontent.cdninstagram.com/v/avatar.jpg?stp=dst-jpg_s150x150_tt6'
const PHOTO_ONE = 'https://scontent.cdninstagram.com/v/one.jpg?stp=dst-jpg_e15_tt6&oh=1'
const PHOTO_TWO = 'https://scontent.cdninstagram.com/v/two.jpg?stp=dst-jpg_e15_tt6&oh=2'

/** Mirrors the real embed: JSON with escaped slashes and a node per post. */
const EMBED_HTML = [
  '<html><script type="application/json">',
  '{',
  `"username":"natgeo","full_name":"National Geographic","followers_count":280000000,`,
  `"profile_pic_url":"${AVATAR.replace(/\//g, '\\/')}",`,
  '"edge_owner_to_timeline_media":{"edges":[',
  `{"node":{"shortcode":"AAA11","display_url":"${PHOTO_ONE.replace(/\//g, '\\/').replace(/&/g, '\\u0026')}","is_video":false}},`,
  `{"node":{"shortcode":"BBB22","is_video":false}},`,
  `{"node":{"shortcode":"CCC33","display_url":"${PHOTO_TWO.replace(/\//g, '\\/').replace(/&/g, '\\u0026')}","is_video":true}},`,
  `{"node":{"shortcode":"DDD44","display_url":"${PHOTO_TWO.replace(/\//g, '\\/').replace(/&/g, '\\u0026')}","is_video":false}},`,
  `{"node":{"shortcode":"AAA11","display_url":"${PHOTO_ONE.replace(/\//g, '\\/')}","is_video":false}}`,
  ']}}',
  '</script></html>',
].join('')

function stubEmbed(html = EMBED_HTML) {
  const fetchMock = vi.fn(async () => new Response(html, { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchProfileEmbed', () => {
  it('keeps shortcodes, display urls and video flags aligned', async () => {
    stubEmbed()
    const info = await fetchProfileEmbed('natgeo')

    expect(info.username).toBe('natgeo')
    expect(info.avatarUrl).toBe(AVATAR)
    expect(info.recentShortcodes).toEqual(['AAA11', 'BBB22', 'CCC33', 'DDD44'])
    expect(info.recentDisplayUrls).toEqual([PHOTO_ONE, '', PHOTO_TWO, PHOTO_TWO])
    expect(info.videoFlags).toEqual([false, false, true, false])
  })
})

describe('resolveInstagramProfile', () => {
  it('uses the signed CDN display urls and skips videos or url-less posts', async () => {
    stubEmbed()
    const result = await resolveInstagramProfile({
      username: 'natgeo',
      env: {} as Env,
      withPhotos: true,
      maxItems: 10,
    })

    expect(result.photos.map((item) => item.url)).toEqual([PHOTO_ONE, PHOTO_TWO])
    expect(result.items[0].url).toBe(AVATAR)
    expect(result.photos.every((item) => !item.url.includes('/media/?size='))).toBe(true)
    expect(result.photoCount).toBe(2)
    expect(result.videoCount).toBe(1)
  })

  it('honours the photo cap without counting skipped posts', async () => {
    stubEmbed()
    const result = await resolveInstagramProfile({
      username: 'natgeo',
      env: {} as Env,
      withPhotos: true,
      maxItems: 1,
    })

    expect(result.photos.map((item) => item.url)).toEqual([PHOTO_ONE])
  })
})
