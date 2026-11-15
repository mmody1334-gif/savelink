import { describe, expect, it } from 'vitest'
import { parseFrameCommandArgs, parseTimestampSeconds } from '../src/telegram/webhook'

describe('parseFrameCommandArgs', () => {
  it('parses hyphenated range without URL', () => {
    const res = parseFrameCommandArgs('00:01-0:20')
    expect(res).toEqual({
      start: '00:01',
      end: '0:20',
      url: '',
    })
  })

  it('parses hyphenated range with spaces around hyphen', () => {
    const res = parseFrameCommandArgs('00:05 - 00:15')
    expect(res).toEqual({
      start: '00:05',
      end: '00:15',
      url: '',
    })
  })

  it('parses hyphenated range with direct URL', () => {
    const res = parseFrameCommandArgs('00:01-0:20 https://pixeldrain.com/u/test123')
    expect(res).toEqual({
      start: '00:01',
      end: '0:20',
      url: 'https://pixeldrain.com/u/test123',
    })
  })

  it('parses seconds-only range with hyphen', () => {
    const res = parseFrameCommandArgs('5-15')
    expect(res).toEqual({
      start: '5',
      end: '15',
      url: '',
    })
  })

  it('parses space-separated range without URL', () => {
    const res = parseFrameCommandArgs('00:02 00:10')
    expect(res).toEqual({
      start: '00:02',
      end: '00:10',
      url: '',
    })
  })

  it('parses space-separated range with URL', () => {
    const res = parseFrameCommandArgs('10 25 https://example.com/video.mp4')
    expect(res).toEqual({
      start: '10',
      end: '25',
      url: 'https://example.com/video.mp4',
    })
  })

  it('parses three-part timestamps (HH:MM:SS)', () => {
    const res = parseFrameCommandArgs('01:05:10-01:05:30')
    expect(res).toEqual({
      start: '01:05:10',
      end: '01:05:30',
      url: '',
    })
  })

  it('returns null for empty or invalid input', () => {
    expect(parseFrameCommandArgs('')).toBeNull()
    expect(parseFrameCommandArgs('   ')).toBeNull()
    expect(parseFrameCommandArgs('hello')).toBeNull()
  })
})

describe('parseTimestampSeconds', () => {
  it('parses seconds', () => {
    expect(parseTimestampSeconds('45')).toBe(45)
  })

  it('parses MM:SS format', () => {
    expect(parseTimestampSeconds('01:20')).toBe(80)
    expect(parseTimestampSeconds('00:05')).toBe(5)
  })

  it('parses HH:MM:SS format', () => {
    expect(parseTimestampSeconds('01:00:00')).toBe(3600)
    expect(parseTimestampSeconds('01:02:03')).toBe(3723)
  })

  it('handles invalid inputs gracefully', () => {
    expect(parseTimestampSeconds('invalid')).toBe(0)
    expect(parseTimestampSeconds('')).toBe(0)
  })

  it('computes valid duration for frame window validation', () => {
    const start = parseTimestampSeconds('00:01')
    const end = parseTimestampSeconds('00:20')
    const duration = end - start
    expect(duration).toBe(19)
    expect(duration).toBeGreaterThan(0)
    expect(duration).toBeLessThanOrEqual(60)
  })
})
