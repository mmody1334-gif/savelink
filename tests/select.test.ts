import { describe, expect, it } from 'vitest'
import {
  cleanButtonText,
  durationLabel,
  humanSize,
  itemFilename,
  pickForMode,
  qualityLabel,
  sanitizeFilename,
  trimForTelegram,
} from '../src/select'
import type { MediaItem, MediaResult } from '../src/types'

const video = (height: number, url: string): MediaItem => ({
  kind: 'video',
  url,
  ext: 'mp4',
  mime: 'video/mp4',
  height,
})

const items: MediaItem[] = [
  video(360, 'a'),
  video(720, 'b'),
  video(720, 'c'),
  { kind: 'audio', url: 'd', ext: 'mp3', mime: 'audio/mpeg' },
  { kind: 'image', url: 'e', ext: 'jpg', mime: 'image/jpeg' },
]

describe('trimForTelegram', () => {
  it('keeps the best distinct heights, one audio track and photos', () => {
    expect(trimForTelegram(items).map((item) => item.url)).toEqual(['b', 'a', 'd', 'e'])
  })

  it('caps video variants', () => {
    const many = Array.from({ length: 8 }, (_, index) => video((index + 1) * 100, `v${index}`))
    expect(trimForTelegram(many).length).toBe(3)
  })
})

describe('pickForMode', () => {
  it('picks the closest height at or below the requested quality', () => {
    expect(pickForMode(items, 'video', '480')?.url).toBe('a')
    expect(pickForMode(items, 'video', 'max')?.url).toBe('b')
  })

  it('prefers the audio track', () => {
    expect(pickForMode(items, 'audio', 'max')?.url).toBe('d')
  })

  it('returns undefined when there is no video', () => {
    expect(pickForMode([], 'video', '720')).toBeUndefined()
  })
})

describe('labels and filenames', () => {
  it('labels formats', () => {
    expect(qualityLabel(video(1080, 'x'))).toBe('1080p')
    expect(qualityLabel({ kind: 'audio', url: 'x', ext: 'm4a', mime: 'audio/mp4' })).toBe('M4A')
  })

  it('formats sizes and durations', () => {
    expect(humanSize(1536)).toBe('1.5KB')
    expect(humanSize(0)).toBe('')
    expect(durationLabel(83)).toBe('1:23')
  })

  it('sanitizes titles for Telegram', () => {
    expect(sanitizeFilename('a/b:c*?  d')).toBe('a b c d')
    expect(sanitizeFilename('   ')).toBe('savelink-media')
  })

  it('builds a filename from the result title', () => {
    const result: MediaResult = { platform: 'tiktok', sourceUrl: '', items: [], engine: 'tiktok', title: 'My Video' }
    expect(itemFilename(result, video(720, 'x'))).toBe('My Video.mp4')
  })

  it('safely truncates button text without breaking UTF-8 surrogates', () => {
    const emojiStr = 'Who wanna water my huge boobs🧐😏🤭😍?!Stay tuned!!!!!! ❤️‍🔥'
    const clean = cleanButtonText(emojiStr, 30)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(clean)).toBe(false)
    expect(clean.endsWith('…')).toBe(true)
    expect(cleanButtonText('Short &amp; clean')).toBe('Short & clean')
  })
})
