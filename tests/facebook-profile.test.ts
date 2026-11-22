import { describe, expect, it, vi } from 'vitest'
import {
  parseFacebookProfile,
  findFacebookProfile,
  isFacebookPhoto,
} from '../src/platforms'
import {
  extractFacebookPhotos,
  resolveFacebookProfile,
} from '../src/facebook-profile'

describe('parseFacebookProfile', () => {
  it.each([
    ['https://www.facebook.com/zuck', 'zuck', 'username'],
    ['https://www.facebook.com/zuck/', 'zuck', 'username'],
    ['https://facebook.com/BillGates', 'BillGates', 'username'],
    ['https://m.facebook.com/zuck', 'zuck', 'username'],
    ['https://fb.com/zuck', 'zuck', 'username'],
    ['https://www.facebook.com/profile.php?id=100088921828', '100088921828', 'id'],
    ['https://m.facebook.com/profile.php?id=4', '4', 'id'],
    ['https://www.facebook.com/people/Mohamed-Ali/100088921828/', '100088921828', 'id'],
  ])('%s -> %s (%s)', (input, expectedValue, expectedKind) => {
    const target = parseFacebookProfile(input)
    expect(target).not.toBeNull()
    expect(target?.value).toBe(expectedValue)
    expect(target?.kind).toBe(expectedKind)
  })

  it.each([
    'https://www.facebook.com/reel/123456789/',
    'https://www.facebook.com/watch/?v=123456789',
    'https://www.facebook.com/share/r/abc/',
    'https://www.facebook.com/photo.php?fbid=123',
    'https://www.facebook.com/plugins/video.php',
    'https://www.facebook.com/groups/123/',
    'https://www.facebook.com/stories/4/',
    'https://www.facebook.com/stories/highlights/123/',
    'https://instagram.com/zuck',
    'hello world',
  ])('rejects non-profile URL: %s', (input) => {
    expect(parseFacebookProfile(input)).toBeNull()
  })
})

describe('findFacebookProfile', () => {
  it('finds a profile inside text', () => {
    const text = 'Check out his profile https://www.facebook.com/zuck please'
    const target = findFacebookProfile(text)
    expect(target?.value).toBe('zuck')
    expect(target?.kind).toBe('username')
  })
})

describe('isFacebookPhoto', () => {
  it.each([
    ['https://www.facebook.com/photo/?fbid=10118046114783111', true],
    ['https://www.facebook.com/photo.php?fbid=10118046114783111', true],
    ['https://m.facebook.com/photo.php?fbid=10118046114783111', true],
    ['https://www.facebook.com/zuck/photos/a.123/456/', true],
    ['https://www.facebook.com/zuck', false],
    ['https://www.facebook.com/reel/12345', false],
    ['https://www.facebook.com/stories/4/', false],
  ])('%s -> %s', (url, expected) => {
    expect(isFacebookPhoto(url)).toBe(expected)
  })
})

describe('extractFacebookPhotos', () => {
  it('extracts unique scontent photos, skipping avatar and reaction stickers', () => {
    const avatarUrl = 'https://scontent.fbcdn.net/v/avatar_123.jpg?stp=c0.0.100x100'
    const html = `
      <script>
        {"uri":"https:\\/\\/scontent.fbcdn.net\\/v\\/avatar_123.jpg?stp=c0.0.100x100"}
        {"uri":"https:\\/\\/scontent.fbcdn.net\\/v\\/photo_1.jpg?stp=dst-jpg_tt6&cstp=mx1536x2048"}
        {"uri":"https:\\/\\/scontent.fbcdn.net\\/v\\/photo_2.jpg?stp=dst-jpg_tt6&cstp=mx1080x1350"}
        {"uri":"https:\\/\\/scontent.fbcdn.net\\/v\\/photo_1.jpg?stp=dst-jpg_tt6&cstp=s200x200"}
        {"uri":"https:\\/\\/scontent.fbcdn.net\\/rsrc.php\\/v3\\/yZ\\/r\\/emoji.png"}
        {"uri":"https:\\/\\/scontent.fbcdn.net\\/m1\\/v\\/t6\\/AQsticker.png"}
      </script>
    `
    const photos = extractFacebookPhotos(html, 10, avatarUrl)
    expect(photos.length).toBe(2)
    expect(photos[0].url).toContain('photo_1.jpg')
    expect(photos[0].label).toContain('mx1536x2048')
    expect(photos[1].url).toContain('photo_2.jpg')
  })
})

describe('resolveFacebookProfile', () => {
  it('resolves name, avatar, userId, and photos from mock HTML', async () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="Mark Zuckerberg" />
          <meta property="og:image" content="https://scontent.fbcdn.net/v/avatar_hd.jpg?stp=mx2048x2048" />
        </head>
        <body>
          <script>
            {"userID":"4","owning_profile":{"id":"4"}}
            {"story_bucket":{"nodes":[{"id":"1461420177232682"}]}}
            {"uri":"https:\\/\\/scontent.fbcdn.net\\/v\\/photo_a.jpg?stp=dst-jpg_tt6&cstp=mx1536x2048"}
            {"uri":"https:\\/\\/scontent.fbcdn.net\\/v\\/photo_b.jpg?stp=dst-jpg_tt6&cstp=mx1080x1350"}
          </script>
        </body>
      </html>
    `

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(mockHtml),
    } as any)

    try {
      const res = await resolveFacebookProfile({
        target: 'https://www.facebook.com/zuck',
        env: {},
        maxItems: 10,
      })

      expect(res.info.name).toBe('Mark Zuckerberg')
      expect(res.info.userId).toBe('4')
      expect(res.info.avatarUrl).toContain('avatar_hd.jpg')
      expect(res.info.hd).toBe(true)
      expect(res.info.storyBucketId).toBe('1461420177232682')
      expect(res.photoCount).toBe(2)
      expect(res.photos.length).toBe(2)
      // Items has avatar at index 0, followed by the 2 photos
      expect(res.items.length).toBe(3)
      expect(res.items[0].kind).toBe('image')
      expect(res.items[0].label).toContain('HD')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('finds every highlight collection behind Facebook\'s escaped-slash JSON', async () => {
    // Relay JSON inside the page escapes every slash, so a highlights shelf
    // link arrives as "https:\/\/www.facebook.com\/stories\/highlights\/<id>\".
    // A raw-HTML match for "/stories/highlights/" misses it.
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="Aas Abrii" />
          <meta property="og:image" content="https://scontent.fbcdn.net/v/avatar.jpg?stp=mx1080x1080" />
        </head>
        <body>
          <a href="/stories/highlights/987654321/">Highlights</a>
          <script>
            {"userID":"61550011223344"}
            {"url":"https:\\/\\/www.facebook.com\\/stories\\/highlights\\/123456789\\/"}
            {"highlight_id":"555000111"}
            {"url":"https:\\/\\/www.facebook.com\\/stories\\/highlights\\/123456789\\/?ref=profile"}
          </script>
        </body>
      </html>
    `

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(mockHtml),
    } as any)

    try {
      const res = await resolveFacebookProfile({
        target: 'https://www.facebook.com/aasabrii',
        env: { FB_COOKIE: 'session' },
        maxItems: 10,
      })

      expect(res.info.highlightIds).toEqual(['987654321', '123456789', '555000111'])
      expect(res.info.highlightId).toBe('987654321')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reports an expired session when the login wall arrives WITH a cookie set', async () => {
    const loginWall = `
      <!DOCTYPE html>
      <html>
        <head><title>Log into Facebook</title></head>
        <body><form id="login_form" action="/login/?login_attempt=1"></form></body>
      </html>
    `

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(loginWall),
    } as any)

    try {
      await expect(
        resolveFacebookProfile({
          target: 'https://www.facebook.com/aasabrii',
          env: { FB_COOKIE: 'stale' },
        }),
      ).rejects.toThrow(/expired|rejected/i)

      await expect(
        resolveFacebookProfile({
          target: 'https://www.facebook.com/aasabrii',
          env: {},
        }),
      ).rejects.toThrow(/login session|Set FB_COOKIE/i)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
