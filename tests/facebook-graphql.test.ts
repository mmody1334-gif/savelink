import { describe, expect, it, vi } from 'vitest'
import {
  extractFbDtsg,
  parseHighlightCollections,
  parseStoryBucketMedia,
} from '../src/facebook-graphql'
import { fetchFacebookHighlights } from '../src/facebook-stories'

const tileResponse = JSON.stringify({
  data: {
    node: {
      __typename: 'ProfileTileView',
      profile_tile_items: {
        edges: [
          {
            node: {
              node: {
                __typename: 'StoryHighlightContainer',
                id: '1111111111111111',
                name: 'Trips',
                highlighted_cards: { count: 4 },
                cover_card: { attachments: [{ media: { __typename: 'Photo' } }] },
              },
            },
          },
          {
            node: {
              node: {
                __typename: 'StoryHighlightContainer',
                id: '2222222222222222',
                name: 'Food',
                highlighted_cards: { count: 2 },
              },
            },
          },
          { node: { node: { __typename: 'Photo', id: '999' } } },
        ],
        page_info: { has_next_page: false, end_cursor: 'abc' },
      },
    },
  },
})

const bucketResponse = JSON.stringify({
  data: {
    node: {
      unified_stories: {
        edges: [
          {
            node: {
              attachments: [
                {
                  media: {
                    __isMedia: 'Video',
                    videoDeliveryResponseFragment: {
                      videoDeliveryResponseResult: {
                        progressive_urls: [
                          { progressive_url: 'https://video.example/sd.mp4', metadata: { quality: 'SD' } },
                          { progressive_url: 'https://video.example/hd.mp4', metadata: { quality: 'HD' } },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
          {
            node: {
              attachments: [
                { media: { __isMedia: 'Photo', image: { uri: 'https://img.example/1.jpg' } } },
              ],
            },
          },
        ],
      },
    },
  },
})

describe('facebook graphql helpers', () => {
  it('extracts fb_dtsg from page html', () => {
    expect(extractFbDtsg('{"DTSGInitialData":[],"token":"NAfx123abc"}')).toBe('NAfx123abc')
    expect(extractFbDtsg('<html>nothing</html>')).toBeUndefined()
  })

  it('parses highlight collections with ids, titles and counts', () => {
    const { collections, hasNextPage } = parseHighlightCollections(tileResponse)
    expect(hasNextPage).toBe(false)
    expect(collections).toEqual([
      { id: '1111111111111111', title: 'Trips', count: 4 },
      { id: '2222222222222222', title: 'Food', count: 2 },
    ])
  })

  it('parses story bucket media preferring HD video and photo images', () => {
    const items = parseStoryBucketMedia(bucketResponse)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ kind: 'video', url: 'https://video.example/hd.mp4', label: 'HD' })
    expect(items[1]).toMatchObject({ kind: 'image', url: 'https://img.example/1.jpg' })
  })

  it('handles JSONL responses and junk lines', () => {
    const raw = `for (;;);{"junk":true}\n${bucketResponse}\n{"extensions":{}}`
    expect(parseStoryBucketMedia(raw)).toHaveLength(2)
    expect(parseHighlightCollections('{"a":1}\n{"profile_tile_items":{"edges":[]}}')).toEqual({
      collections: [],
      hasNextPage: false,
      endCursor: undefined,
    })
  })
})

describe('fetchFacebookHighlights session-token fast path', () => {
  const env = { FB_COOKIE: 'c_user=123; xs=fake' } as any

  it('skips the stories shell page and posts GraphQL directly when dtsg is provided', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: any, init?: any) => {
      calls.push(`${init?.method || 'GET'} ${String(input)}`)
      return new Response(bucketResponse, { status: 200 })
    })
    try {
      const res = await fetchFacebookHighlights('1431061792450191', env, { dtsg: 'TOKEN123' })
      expect(res.items).toHaveLength(2)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toBe('POST https://www.facebook.com/api/graphql/')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('still loads the stories shell page when no dtsg is provided', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: any, init?: any) => {
      calls.push(`${init?.method || 'GET'} ${String(input)}`)
      return new Response('<html><body>no media here</body></html>', { status: 200 })
    })
    try {
      const res = await fetchFacebookHighlights('1431061792450191', env)
      expect(res.items).toHaveLength(0)
      expect(calls[0]).toBe('GET https://www.facebook.com/stories/highlights/1431061792450191/')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
