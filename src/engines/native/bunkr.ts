import { EngineError } from '../../errors'
import { parseBunkrUrl, fetchBunkrAlbum, resolveBunkrFile } from '../../bunkr'
import type { Env, MediaItem, MediaResult, ResolveInput } from '../../types'

export async function extractBunkr(input: ResolveInput, _env?: Env): Promise<MediaResult> {
  const target = parseBunkrUrl(input.url)
  if (!target) {
    throw new EngineError('Invalid Bunkr link', 'native', false)
  }

  if (target.kind === 'file') {
    const file = await resolveBunkrFile(target.id, target.domain)
    const item: MediaItem = {
      kind: 'video',
      url: file.directUrl,
      ext: file.ext,
      mime: file.ext === 'mp4' || file.ext === 'm4v' ? 'video/mp4' : 'application/octet-stream',
      label: file.title.slice(0, 30),
    }

    return {
      platform: 'bunkr',
      sourceUrl: input.url,
      title: file.title,
      author: target.domain,
      thumbnail: file.thumb,
      items: [item],
      engine: 'native',
    }
  }

  // Album
  const album = await fetchBunkrAlbum(target.id, target.domain)
  if (!album.files.length) {
    throw new EngineError('No files found in this Bunkr album', 'native', false)
  }

  // Resolve first file for quick preview or present album items
  const items: MediaItem[] = []
  for (const f of album.files) {
    items.push({
      kind: f.kind === 'video' ? 'video' : 'image',
      url: f.url,
      ext: 'mp4',
      mime: 'video/mp4',
      label: f.name,
    })
  }

  return {
    platform: 'bunkr',
    sourceUrl: input.url,
    title: album.title,
    author: target.domain,
    thumbnail: album.files.find((f) => f.thumb)?.thumb,
    items,
    engine: 'native',
  }
}
