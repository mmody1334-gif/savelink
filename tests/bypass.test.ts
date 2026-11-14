import { describe, expect, it } from 'vitest'
import {
  decodeAdfly,
  extractEmbeddedUrl,
  isShortenerOrAdLink,
} from '../src/bypass'

describe('bypass engine', () => {
  it('detects shortener and ad-link domains', () => {
    expect(isShortenerOrAdLink('https://bit.ly/test1234')).toBe(true)
    expect(isShortenerOrAdLink('https://tinyurl.com/something')).toBe(true)
    expect(isShortenerOrAdLink('https://ouo.io/abc')).toBe(true)
    expect(isShortenerOrAdLink('https://linkvertise.com/123/test')).toBe(true)
    expect(isShortenerOrAdLink('https://google.com')).toBe(false)
  })

  it('extracts embedded target URLs from query parameters', () => {
    // Direct URL in param
    const url1 = 'https://some-ad-site.com/redirect?url=https%3A%2F%2Fexample.com%2Ftarget'
    expect(extractEmbeddedUrl(url1)).toBe('https://example.com/target')

    // Base64 encoded URL in param
    const base64Target = btoa('https://destination.org/final')
    const url2 = `https://intermediary.net/go?dest=${base64Target}`
    expect(extractEmbeddedUrl(url2)).toBe('https://destination.org/final')

    // No target
    expect(extractEmbeddedUrl('https://example.com/page?id=123')).toBeNull()
  })

  it('decodes adfly token correctly', () => {
    // Test with a known AdFly ysmm token structure or verify null on invalid
    expect(decodeAdfly('invalid_token')).toBeNull()
  })
})
