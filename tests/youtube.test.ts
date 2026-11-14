import { describe, expect, it } from 'vitest'
import { formatDuration } from '../src/youtube'
import { parseYouTubeVideo, parseYouTubePlaylist } from '../src/platforms'

describe('formatDuration', () => {
  it('formats seconds into minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(45)).toBe('0:45')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(213)).toBe('3:33')
    expect(formatDuration(3665)).toBe('1:01:05')
  })
})

describe('YouTube URL parsing', () => {
  it('extracts correct videoId', () => {
    const video = parseYouTubeVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(video?.videoId).toBe('dQw4w9WgXcQ')
  })

  it('extracts correct playlistId', () => {
    const pl = parseYouTubePlaylist('https://www.youtube.com/playlist?list=PL1234567890abcdef')
    expect(pl?.playlistId).toBe('PL1234567890abcdef')
  })
})
