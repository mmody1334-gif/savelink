import { describe, expect, it } from 'vitest'
import { parseBunkrUrl } from '../src/bunkr'
import { detectPlatform } from '../src/platforms'

describe('bunkr platform parser', () => {
  it('detects bunkr domains', () => {
    expect(detectPlatform('https://bunkr.cr/a/ir5efLgB')).toBe('bunkr')
    expect(detectPlatform('https://bunkr.is/f/Q7oO7BR7Zs1uC')).toBe('bunkr')
    expect(detectPlatform('https://bunkr.si/a/12345')).toBe('bunkr')
    expect(detectPlatform('https://bunkr.black/f/999')).toBe('bunkr')
    expect(detectPlatform('https://bunkrr.su/f/111')).toBe('bunkr')
  })

  it('parses valid bunkr album url', () => {
    const parsed = parseBunkrUrl('https://bunkr.cr/a/ir5efLgB')
    expect(parsed).toEqual({
      kind: 'album',
      id: 'ir5efLgB',
      domain: 'bunkr.cr',
      url: 'https://bunkr.cr/a/ir5efLgB',
    })
  })

  it('parses valid bunkr file url', () => {
    const parsed = parseBunkrUrl('https://bunkr.cr/f/Q7oO7BR7Zs1uC')
    expect(parsed).toEqual({
      kind: 'file',
      id: 'Q7oO7BR7Zs1uC',
      domain: 'bunkr.cr',
      url: 'https://bunkr.cr/f/Q7oO7BR7Zs1uC',
    })
  })

  it('parses /v/ variant', () => {
    const parsed = parseBunkrUrl('https://bunkr.is/v/myVideo123')
    expect(parsed).toEqual({
      kind: 'file',
      id: 'myVideo123',
      domain: 'bunkr.is',
      url: 'https://bunkr.is/f/myVideo123',
    })
  })

  it('rejects non-bunkr or root urls', () => {
    expect(parseBunkrUrl('https://bunkr.cr/')).toBeNull()
    expect(parseBunkrUrl('https://google.com/a/123')).toBeNull()
  })
})
