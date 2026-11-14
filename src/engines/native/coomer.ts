import { EngineError } from '../../errors'
import { parseCoomerUrl } from '../../platforms'
import type { Env, MediaItem, MediaResult, ResolveInput } from '../../types'
import {
  fetchCoomerPosts,
  fetchCoomerSinglePost,
  postToMediaItems,
  extractVideosFromPosts,
  fetchCoomerFansPost,
  fetchCoomerFansPosts,
} from '../../coomer'

export async function extractCoomer(input: ResolveInput, _env?: Env): Promise<MediaResult> {
  const target = parseCoomerUrl(input.url)
  if (!target) {
    throw new EngineError('Invalid Coomer / Kemono link', 'native', false)
  }

  const { domain, service, creatorId, postId, offset, username, page } = target

  if (domain.includes('coomerfans')) {
    if (postId) {
      const post = await fetchCoomerFansPost(postId, creatorId, service)
      if (!post) {
        throw new EngineError('Could not load CoomerFans post', 'native', true)
      }

      const items: MediaItem[] = []
      for (let i = 0; i < post.videos.length; i++) {
        items.push({
          kind: 'video',
          url: post.videos[i],
          ext: 'mp4',
          mime: 'video/mp4',
          label: post.videos.length > 1 ? `Video ${i + 1}` : post.title.slice(0, 30),
        })
      }
      for (let i = 0; i < post.images.length; i++) {
        items.push({
          kind: 'image',
          url: post.images[i],
          ext: 'jpg',
          mime: 'image/jpeg',
          label: `Photo ${i + 1}`,
        })
      }

      if (!items.length) {
        throw new EngineError('No downloadable media found in this CoomerFans post', 'native', false)
      }

      return {
        platform: 'coomer',
        sourceUrl: input.url,
        title: post.title,
        author: creatorId || 'CoomerFans',
        thumbnail: items.find((i) => i.kind === 'image')?.url,
        items,
        engine: 'native',
      }
    }

    // CoomerFans creator page
    const profile = await fetchCoomerFansPosts(service, creatorId, username, page ?? 1)
    if (!profile || !profile.posts.length) {
      throw new EngineError('No posts found for this creator on CoomerFans', 'native', true)
    }

    return {
      platform: 'coomer',
      sourceUrl: input.url,
      title: `${profile.title} (${profile.service}) - Page ${page ?? 1}`,
      author: profile.title,
      thumbnail: profile.avatarUrl,
      items: [],
      engine: 'native',
    }
  }

  // If single post
  if (postId) {
    const post = await fetchCoomerSinglePost(domain, service, creatorId, postId)
    if (!post) {
      throw new EngineError('Could not load Coomer post', 'native', true)
    }

    const items = postToMediaItems(post, domain)
    if (!items.length) {
      throw new EngineError('No media found in this Coomer post', 'native', false)
    }

    return {
      platform: 'coomer',
      sourceUrl: input.url,
      title: post.title || `Post ${post.id}`,
      author: `${post.user} (${post.service})`,
      thumbnail: items.find((i) => i.kind === 'image')?.url,
      items,
      engine: 'native',
    }
  }

  // If creator profile / offset
  const posts = await fetchCoomerPosts(domain, service, creatorId, offset ?? 0)
  if (!posts.length) {
    throw new EngineError('No posts found for this creator/page', 'native', true)
  }

  const videos = extractVideosFromPosts(posts, domain)
  if (!videos.length) {
    const items = posts.flatMap((p) => postToMediaItems(p, domain)).slice(0, 30)
    if (!items.length) {
      throw new EngineError('No media found on this Coomer page', 'native', false)
    }
    return {
      platform: 'coomer',
      sourceUrl: input.url,
      title: `${creatorId} (${service}) - Page ${offset ?? 0}`,
      author: creatorId,
      items,
      engine: 'native',
    }
  }

  const items = videos.map((v) => ({
    kind: 'video' as const,
    url: v.videoUrl,
    ext: 'mp4',
    mime: 'video/mp4',
    label: v.title.slice(0, 40),
  }))

  return {
    platform: 'coomer',
    sourceUrl: input.url,
    title: `${creatorId} (${service}) - ${videos.length} videos`,
    author: creatorId,
    thumbnail: videos[0]?.thumbnailUrl,
    items,
    engine: 'native',
  }
}
