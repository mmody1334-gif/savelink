import { describe, expect, it } from 'vitest'
import {
  findInstagramProfile,
  isInstagramUsername,
  parseInstagramProfile,
} from '../src/platforms'
import { profileMaxItems } from '../src/config'
import { chunk } from '../src/telegram/send'

describe('parseInstagramProfile', () => {
  it.each([
    ['https://www.instagram.com/natgeo/', 'natgeo'],
    ['https://www.instagram.com/natgeo', 'natgeo'],
    ['https://instagram.com/natgeo/?hl=en', 'natgeo'],
    ['https://instagr.am/natgeo/', 'natgeo'],
    ['@natgeo', 'natgeo'],
    ['natgeo', 'natgeo'],
    ['https://www.instagram.com/nasa.photo/', 'nasa.photo'],
    ['https://www.instagram.com/under_score_1/', 'under_score_1'],
  ])('%s -> %s', (input, username) => {
    expect(parseInstagramProfile(input)?.username).toBe(username)
  })

  it.each([
    'https://www.instagram.com/p/Cabc123/',
    'https://www.instagram.com/reel/Cabc123/',
    'https://www.instagram.com/reels/Cabc123/',
    'https://www.instagram.com/tv/Cabc123/',
    'https://www.instagram.com/stories/natgeo/123/',
    'https://www.instagram.com/explore/tags/travel/',
    'https://www.instagram.com/accounts/login/',
    'https://www.instagram.com/share/abc/',
    'https://www.instagram.com/natgeo/reels/',
    'https://www.instagram.com/api/v1/users/1/info/',
    'https://www.instagram.com/explore/',
    'https://www.instagram.com/.hidden/',
    'https://www.instagram.com/bad-name!/',
    'https://example.com/natgeo/',
    'hello world',
  ])('rejects %s', (input) => {
    expect(parseInstagramProfile(input)).toBeNull()
  })

  it('validates usernames', () => {
    expect(isInstagramUsername('natgeo')).toBe(true)
    expect(isInstagramUsername('.natgeo')).toBe(false)
    expect(isInstagramUsername('natgeo.')).toBe(false)
    expect(isInstagramUsername('a'.repeat(31))).toBe(false)
    expect(isInstagramUsername('bad name')).toBe(false)
  })
})

describe('findInstagramProfile', () => {
  it('finds a profile inside a sentence', () => {
    expect(findInstagramProfile('please download https://instagram.com/natgeo/ thanks')?.username).toBe('natgeo')
  })

  it('accepts a command argument with @', () => {
    expect(findInstagramProfile('@natgeo')?.username).toBe('natgeo')
  })

  it('does not treat a post link as a profile', () => {
    expect(findInstagramProfile('https://www.instagram.com/reel/DWW6KeRkUT7/')).toBeNull()
  })
})

describe('profileMaxItems', () => {
  it('defaults to 60 and clamps to 300', () => {
    expect(profileMaxItems({})).toBe(60)
    expect(profileMaxItems({ PROFILE_MAX_ITEMS: '25' })).toBe(25)
    expect(profileMaxItems({ PROFILE_MAX_ITEMS: '999' })).toBe(300)
    expect(profileMaxItems({ PROFILE_MAX_ITEMS: 'nope' })).toBe(60)
  })
})

describe('chunk', () => {
  it('splits photos into Telegram albums of 10', () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]])
    const groups = chunk(Array.from({ length: 23 }, (_, index) => index), 10)
    expect(groups.map((group) => group.length)).toEqual([10, 10, 3])
  })
})
