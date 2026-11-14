import { describe, expect, it } from 'vitest'
import {
  extractVideosFromPosts,
  postToMediaItems,
  isVideoFile,
  isImageFile,
  buildCoomerCdnUrl,
  type CoomerPost,
} from '../src/coomer'

describe('coomer media helpers', () => {
  it('detects video and image file extensions', () => {
    expect(isVideoFile('sample.mp4')).toBe(true)
    expect(isVideoFile('sample.m4v')).toBe(true)
    expect(isVideoFile('sample.jpg')).toBe(false)
    expect(isImageFile('sample.jpg')).toBe(true)
    expect(isImageFile('sample.png')).toBe(true)
    expect(isImageFile('sample.mp4')).toBe(false)
  })

  it('builds direct CDN URL from path', () => {
    expect(buildCoomerCdnUrl('coomer.st', '/ab/cd/ef.mp4')).toMatch(/^https:\/\/n[1-4]\.coomer\.st\/data\/ab\/cd\/ef\.mp4$/)
  })

  it('extracts videos from post list', () => {
    const posts: CoomerPost[] = [
      {
        id: '101',
        user: 'creator1',
        service: 'onlyfans',
        title: 'Video Post 1',
        file: {
          name: 'vid1.mp4',
          path: '/11/22/vid1.mp4',
        },
        attachments: [
          {
            name: 'preview.jpg',
            path: '/11/22/preview.jpg',
          },
        ],
      },
      {
        id: '102',
        user: 'creator1',
        service: 'onlyfans',
        title: 'Photo Post',
        file: {
          name: 'photo.jpg',
          path: '/33/44/photo.jpg',
        },
      },
    ]

    const videos = extractVideosFromPosts(posts, 'coomer.st')
    expect(videos).toHaveLength(1)
    expect(videos[0].id).toBe('101')
    expect(videos[0].videoUrl).toMatch(/^https:\/\/n[1-4]\.coomer\.st\/data\/11\/22\/vid1\.mp4$/)
    expect(videos[0].thumbnailUrl).toContain('/11/22/preview.jpg')
  })

  it('converts single post to MediaItems', () => {
    const post: CoomerPost = {
      id: '202',
      user: 'creator2',
      service: 'fansly',
      title: 'Multi media post',
      file: {
        name: 'vid.mp4',
        path: '/55/66/vid.mp4',
      },
      attachments: [
        {
          name: 'extra.jpg',
          path: '/55/66/extra.jpg',
        },
      ],
    }

    const items = postToMediaItems(post, 'coomer.su')
    expect(items).toHaveLength(2)
    expect(items[0].kind).toBe('video')
    expect(items[0].url).toMatch(/^https:\/\/n[1-4]\.coomer\.st\/data\/55\/66\/vid\.mp4$/)
    expect(items[1].kind).toBe('image')
    expect(items[1].url).toMatch(/^https:\/\/n[1-4]\.coomer\.st\/data\/55\/66\/extra\.jpg$/)
  })
})
