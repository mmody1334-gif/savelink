import { describe, expect, it } from 'vitest'
import {
  canonicalTikTokUrl,
  detectPlatform,
  findUrl,
  normalizeUrl,
  parseInstagramStoryLink,
  parseYouTubeVideo,
  parseYouTubePlaylist,
  parseCoomerUrl,
  pinterestPinId,
  shortcodeToMediaId,
} from '../src/platforms'

describe('detectPlatform', () => {
  it.each([
    ['https://www.tiktok.com/@user/video/7123456789', 'tiktok'],
    ['https://vm.tiktok.com/ZMabc123/', 'tiktok'],
    ['https://vt.tiktok.com/ZSabc/', 'tiktok'],
    ['https://www.instagram.com/reel/Cabc123/', 'instagram'],
    ['https://instagram.com/p/Cabc123/', 'instagram'],
    ['https://instagr.am/p/Cabc123/', 'instagram'],
    ['https://www.facebook.com/watch/?v=123', 'facebook'],
    ['https://fb.watch/abc123/', 'facebook'],
    ['https://m.facebook.com/reel/123', 'facebook'],
    ['https://www.pinterest.com/pin/123456/', 'pinterest'],
    ['https://pin.it/abc123', 'pinterest'],
    ['https://pinterest.co.uk/pin/123456/', 'pinterest'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube'],
    ['https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4', 'youtube'],
    ['https://coomer.st/onlyfans/user/asiri_ocean?o=300', 'coomer'],
    ['https://coomer.su/fansly/user/12345/post/6789', 'coomer'],
    ['https://kemono.su/patreon/user/555', 'coomer'],
    ['https://example.com/video/1', 'unknown'],
    ['not a url', 'unknown'],
  ])('%s -> %s', (url, expected) => {
    expect(detectPlatform(url)).toBe(expected)
  })
})

describe('findUrl', () => {
  it('extracts a link from a message', () => {
    expect(findUrl('look at this https://vm.tiktok.com/ZMabc123/ please')).toBe('https://vm.tiktok.com/ZMabc123/')
  })

  it('strips trailing punctuation', () => {
    expect(findUrl('see https://www.instagram.com/reel/Cabc123/.')).toBe('https://www.instagram.com/reel/Cabc123/')
  })

  it('returns undefined when there is no link', () => {
    expect(findUrl('hello world')).toBeUndefined()
  })
})

describe('normalizeUrl', () => {
  it('adds https:// when the scheme is missing', () => {
    expect(normalizeUrl('vm.tiktok.com/ZMabc')).toBe('https://vm.tiktok.com/ZMabc')
  })

  it('drops tracking parameters', () => {
    const url = normalizeUrl(
      'https://www.tiktok.com/@u/video/1?is_from_webapp=1&utm_source=copy&igshid=abc&fbclid=xyz',
    )
    expect(url).toBe('https://www.tiktok.com/@u/video/1?is_from_webapp=1')
  })
})

describe('shortcodeToMediaId', () => {
  it('maps the base64 alphabet to Instagram media ids', () => {
    expect(shortcodeToMediaId('A')).toBe('0')
    expect(shortcodeToMediaId('B')).toBe('1')
    expect(shortcodeToMediaId('BAA')).toBe('4096')
  })

  it('rejects invalid shortcodes', () => {
    expect(shortcodeToMediaId('bad!code')).toBe('')
  })
})

describe('pinterestPinId', () => {
  it('extracts the numeric pin id', () => {
    expect(pinterestPinId('https://www.pinterest.com/pin/987654321/')).toBe('987654321')
  })
})

describe('canonicalTikTokUrl', () => {
  it('keeps canonical urls untouched', async () => {
    const url = 'https://www.tiktok.com/@user/video/123'
    expect(await canonicalTikTokUrl(url)).toBe(url)
  })
})

describe('parseInstagramStoryLink', () => {
  it('parses user story links', () => {
    expect(parseInstagramStoryLink('https://www.instagram.com/stories/username/1234567890/')).toEqual({
      kind: 'story',
      username: 'username',
      storyId: '1234567890',
    })
  })

  it('parses highlight links', () => {
    expect(parseInstagramStoryLink('https://www.instagram.com/stories/highlights/17912345678901234/')).toEqual({
      kind: 'highlight',
      highlightId: 'highlight:17912345678901234',
    })
  })

  it('rejects post and reel links', () => {
    expect(parseInstagramStoryLink('https://www.instagram.com/p/C12345/')).toBeNull()
    expect(parseInstagramStoryLink('https://www.instagram.com/reel/C12345/')).toBeNull()
  })
})

describe('parseYouTubeVideo', () => {
  it('parses standard watch URLs', () => {
    expect(parseYouTubeVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      videoId: 'dQw4w9WgXcQ',
    })
  })

  it('parses youtu.be short URLs', () => {
    expect(parseYouTubeVideo('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      videoId: 'dQw4w9WgXcQ',
    })
  })

  it('parses shorts, embed, and live URLs', () => {
    expect(parseYouTubeVideo('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toEqual({
      videoId: 'dQw4w9WgXcQ',
    })
    expect(parseYouTubeVideo('https://www.youtube.com/embed/dQw4w9WgXcQ')).toEqual({
      videoId: 'dQw4w9WgXcQ',
    })
    expect(parseYouTubeVideo('https://www.youtube.com/live/dQw4w9WgXcQ')).toEqual({
      videoId: 'dQw4w9WgXcQ',
    })
  })

  it('rejects non-YouTube URLs', () => {
    expect(parseYouTubeVideo('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull()
  })
})

describe('parseYouTubePlaylist', () => {
  it('parses playlist URLs', () => {
    expect(parseYouTubePlaylist('https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4')).toEqual({
      playlistId: 'PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
    })
  })

  it('parses watch URLs containing a list parameter', () => {
    expect(parseYouTubePlaylist('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4')).toEqual({
      playlistId: 'PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
    })
  })

  it('rejects watch URLs without a list parameter', () => {
    expect(parseYouTubePlaylist('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull()
  })
})

describe('parseCoomerUrl', () => {
  it('parses creator profile with offset', () => {
    expect(parseCoomerUrl('https://coomer.st/onlyfans/user/asiri_ocean?o=300')).toEqual({
      domain: 'coomer.st',
      service: 'onlyfans',
      creatorId: 'asiri_ocean',
      offset: 300,
    })
  })

  it('parses single post URL', () => {
    expect(parseCoomerUrl('https://coomer.su/fansly/user/12345/post/67890')).toEqual({
      domain: 'coomer.su',
      service: 'fansly',
      creatorId: '12345',
      postId: '67890',
    })
  })

  it('parses CoomerFans creator profile with page', () => {
    expect(parseCoomerUrl('https://coomerfans.com/u/onlyfans/229783/lolalovebunny17?page=2')).toEqual({
      domain: 'coomerfans.com',
      service: 'onlyfans',
      creatorId: '229783',
      username: 'lolalovebunny17',
      page: 2,
      offset: 2,
    })
  })

  it('parses CoomerFans post URL', () => {
    expect(parseCoomerUrl('https://coomerfans.com/p/21144751/229783/onlyfans')).toEqual({
      domain: 'coomerfans.com',
      postId: '21144751',
      creatorId: '229783',
      service: 'onlyfans',
    })
    expect(parseCoomerUrl('https://coomerfans.com/p/9682356/')).toEqual({
      domain: 'coomerfans.com',
      postId: '9682356',
      creatorId: '',
      service: '',
    })
  })

  it('rejects non-Coomer URLs', () => {
    expect(parseCoomerUrl('https://example.com/onlyfans/user/asiri_ocean')).toBeNull()
  })
})

