import { EngineError } from '../../errors'
import { parseEromeUrl, fetchEromeAlbum } from '../../erome'
import type { Env, MediaItem, MediaResult, ResolveInput } from '../../types'

export async function extractErome(input: ResolveInput, _env?: Env): Promise<MediaResult> {
  const target = parseEromeUrl(input.url)
  if (!target) {
    throw new EngineError('Invalid Erome link', 'native', false)
  }

  const album = await fetchEromeAlbum(target.albumId)
  if (!album) {
    throw new EngineError('Could not load Erome album', 'native', true)
  }

  const items: MediaItem[] = []

  for (let i = 0; i < album.videos.length; i++) {
    const v = album.videos[i]
    items.push({
      kind: 'video',
      url: v.url,
      ext: 'mp4',
      mime: 'video/mp4',
      label: album.videos.length > 1 ? `Video ${i + 1}` : album.title.slice(0, 30),
      referer: `https://www.erome.com/a/${target.albumId}`,
    })
  }

  for (let i = 0; i < album.photos.length; i++) {
    const p = album.photos[i]
    items.push({
      kind: 'image',
      url: p.url,
      ext: 'jpg',
      mime: 'image/jpeg',
      label: `Photo ${i + 1}`,
      referer: `https://www.erome.com/a/${target.albumId}`,
    })
  }

  if (!items.length) {
    throw new EngineError('No media found in this Erome album', 'native', false)
  }

  return {
    platform: 'erome',
    sourceUrl: input.url,
    title: album.title,
    author: album.user || 'Erome',
    thumbnail: album.videos[0]?.thumb || album.photos[0]?.thumb,
    items,
    engine: 'native',
  }
}
