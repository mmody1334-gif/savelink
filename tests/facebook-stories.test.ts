import { describe, expect, it, vi } from 'vitest'
import {
  parseFacebookStoryLink,
  type FacebookStoryTarget,
} from '../src/platforms'
import {
  extractStoryMediaFromHtml,
  fetchFacebookStories,
  fetchFacebookHighlights,
} from '../src/facebook-stories'

describe('parseFacebookStoryLink', () => {
  it.each([
    [
      'https://www.facebook.com/stories/4/10118155444854771/',
      { kind: 'story', bucketId: '4', storyId: '10118155444854771' } as FacebookStoryTarget,
    ],
    [
      'https://www.facebook.com/stories/4/',
      { kind: 'story', bucketId: '4', storyId: undefined } as FacebookStoryTarget,
    ],
    [
      'https://m.facebook.com/stories/100088921828/',
      { kind: 'story', bucketId: '100088921828', storyId: undefined } as FacebookStoryTarget,
    ],
    [
      'https://www.facebook.com/stories/highlights/123456789/',
      { kind: 'highlight', highlightId: '123456789' } as FacebookStoryTarget,
    ],
    [
      'https://www.facebook.com/stories/highlights/?bucket_id=987654321',
      { kind: 'highlight', highlightId: '987654321' } as FacebookStoryTarget,
    ],
  ])('%s -> %j', (url, expected) => {
    expect(parseFacebookStoryLink(url)).toEqual(expected)
  })

  it.each([
    'https://www.facebook.com/zuck',
    'https://www.facebook.com/reel/12345',
    'https://instagram.com/stories/user/123',
    'https://example.com/stories/123',
  ])('rejects non-story url %s', (url) => {
    expect(parseFacebookStoryLink(url)).toBeNull()
  })
})

describe('extractStoryMediaFromHtml', () => {
  it('extracts videos and photo cards from story HTML', () => {
    const html = `
      <script>
        {"playable_url_quality_hd":"https:\\/\\/video.fbcdn.net\\/v\\/story_hd.mp4"}
        {"playable_url":"https:\\/\\/video.fbcdn.net\\/v\\/story_sd.mp4"}
        {"story_card_info":{"uri":"https:\\/\\/scontent.fbcdn.net\\/v\\/story_photo.jpg"}}
      </script>
    `
    const items = extractStoryMediaFromHtml(html)
    expect(items.length).toBe(3)
    expect(items[0].kind).toBe('video')
    expect(items[0].url).toContain('story_hd.mp4')
    expect(items[1].kind).toBe('video')
    expect(items[1].url).toContain('story_sd.mp4')
    expect(items[2].kind).toBe('image')
    expect(items[2].url).toContain('story_photo.jpg')
  })
})

describe('fetchFacebookStories and fetchFacebookHighlights', () => {
  it('throws when FB_COOKIE is missing', async () => {
    await expect(fetchFacebookStories('4', {})).rejects.toThrow(/FB_COOKIE/)
    await expect(fetchFacebookHighlights('123', {})).rejects.toThrow(/FB_COOKIE/)
  })

  it('fetches stories when FB_COOKIE is provided', async () => {
    const mockHtml = `
      <head><meta property="og:title" content="Mark Zuckerberg" /></head>
      <body>
        <script>
          {"playable_url_quality_hd":"https:\\/\\/video.fbcdn.net\\/v\\/zuck_story.mp4"}
        </script>
      </body>
    `
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(mockHtml),
    } as any)

    try {
      const res = await fetchFacebookStories('4', { FB_COOKIE: 'c_user=123; xs=abc' })
      expect(res.name).toBe('Mark Zuckerberg')
      expect(res.items.length).toBe(1)
      expect(res.items[0].url).toContain('zuck_story.mp4')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
