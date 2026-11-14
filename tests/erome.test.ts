import { describe, expect, it } from 'vitest'
import { parseEromeUrl } from '../src/erome'
import { detectPlatform } from '../src/platforms'

describe('erome platform parser', () => {
  it('detects erome.com platform', () => {
    expect(detectPlatform('https://www.erome.com/a/tHRlowrS')).toBe('erome')
    expect(detectPlatform('http://erome.com/a/abc12345')).toBe('erome')
    expect(detectPlatform('https://another-site.com/a/123')).toBe('unknown')
  })

  it('parses valid erome album url', () => {
    const parsed = parseEromeUrl('https://www.erome.com/a/tHRlowrS')
    expect(parsed).toEqual({
      albumId: 'tHRlowrS',
      url: 'https://www.erome.com/a/tHRlowrS',
    })
  })

  it('rejects invalid urls', () => {
    expect(parseEromeUrl('https://www.erome.com/help')).toBeNull()
    expect(parseEromeUrl('not a url')).toBeNull()
  })
})
