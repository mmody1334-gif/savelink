import { DESKTOP_UA, httpFetch } from './http'

export interface BunkrSearchResult {
  id: string
  title: string
  url: string
  kind: 'album' | 'file'
  domain: string
  thumb?: string
}

export interface BunkrFileSummary {
  id: string
  url: string
  name: string
  thumb?: string
  kind: 'video' | 'image' | 'file'
}

export interface BunkrAlbumDetail {
  id: string
  title: string
  url: string
  domain: string
  files: BunkrFileSummary[]
}

export interface BunkrResolvedMedia {
  id: string
  title: string
  thumb?: string
  directUrl: string
  size?: number
  ext: string
}

export interface BunkrTarget {
  kind: 'album' | 'file'
  id: string
  domain: string
  url: string
}

const BUNKR_HOST_REGEX = /(?:^|\.)(bunkr\.(?:cr|is|si|black|media|ph|ru|su)|bunkrr\.su)$/i

export function parseBunkrUrl(url: string): BunkrTarget | null {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`)
    const host = parsed.hostname.toLowerCase()
    if (!BUNKR_HOST_REGEX.test(host)) return null

    const matchAlbum = parsed.pathname.match(/\/a\/([a-zA-Z0-9]+)/i)
    if (matchAlbum) {
      return {
        kind: 'album',
        id: matchAlbum[1],
        domain: host,
        url: `https://${host}/a/${matchAlbum[1]}`,
      }
    }

    const matchFile = parsed.pathname.match(/\/(?:f|v)\/([a-zA-Z0-9]+)/i)
    if (matchFile) {
      return {
        kind: 'file',
        id: matchFile[1],
        domain: host,
        url: `https://${host}/f/${matchFile[1]}`,
      }
    }

    return null
  } catch {
    return null
  }
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export async function searchBunkr(query: string): Promise<BunkrSearchResult[]> {
  const ddgQuery = `site:bunkr.cr OR site:bunkr.is OR site:bunkr.si OR site:bunkr.black ${query}`
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(ddgQuery)}`
  
  const res = await httpFetch(
    searchUrl,
    {
      headers: {
        'User-Agent': DESKTOP_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
    8000,
  )

  if (!res.ok) {
    throw new Error(`DuckDuckGo search failed with status ${res.status}`)
  }

  const html = await res.text()
  const results: BunkrSearchResult[] = []
  const seenIds = new Set<string>()

  // Parse result__a links
  const linkMatches = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]

  for (const m of linkMatches) {
    let actualUrl = m[1]
    const uddgMatch = m[1].match(/[?&]uddg=([^&]+)/)
    if (uddgMatch) {
      actualUrl = decodeURIComponent(uddgMatch[1])
    }

    const target = parseBunkrUrl(actualUrl)
    if (!target) continue

    const uniqueKey = `${target.kind}:${target.id}`
    if (seenIds.has(uniqueKey)) continue
    seenIds.add(uniqueKey)

    const rawTitle = m[2].replace(/<[^>]+>/g, '').trim()
    const cleanTitle = decodeHtmlEntities(
      rawTitle
        .replace(/\s*\|\s*Bunkr.*$/i, '')
        .replace(/^Download\s+/i, '')
        .replace(/- BUNKR$/i, '')
        .trim()
    ) || (target.kind === 'album' ? `Album ${target.id}` : `File ${target.id}`)

    results.push({
      id: target.id,
      title: cleanTitle,
      url: target.url,
      kind: target.kind,
      domain: target.domain,
    })

    if (results.length >= 10) break
  }

  return results
}

export async function fetchBunkrAlbum(albumId: string, domain = 'bunkr.cr'): Promise<BunkrAlbumDetail> {
  const url = `https://${domain}/a/${albumId}`
  const res = await httpFetch(
    url,
    {
      headers: {
        'User-Agent': DESKTOP_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    },
    10_000,
  )

  if (!res.ok) {
    throw new Error(`Bunkr album fetch failed with status ${res.status}`)
  }

  const html = await res.text()

  // Extract title
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  const title = decodeHtmlEntities(titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Album ${albumId}`)

  // Extract files
  const files: BunkrFileSummary[] = []
  const rawCards = [...html.matchAll(/href="(\/f\/([a-zA-Z0-9]+))"[\s\S]*?<img[^>]*src="([^"]+)"/gi)]
  const seenFiles = new Set<string>()

  for (const c of rawCards) {
    const fileId = c[2]
    if (seenFiles.has(fileId)) continue
    seenFiles.add(fileId)

    const fileUrl = `https://${domain}${c[1]}`
    let thumb = c[3]
    if (thumb.startsWith('/')) thumb = `https://${domain}${thumb}`

    const isVideo = thumb.includes('video') || c[0].includes('video') || fileUrl.includes('.mp4')
    const isImage = thumb.includes('image') || thumb.includes('.png') || thumb.includes('.jpg')

    files.push({
      id: fileId,
      url: fileUrl,
      name: `File ${fileId}`,
      thumb: thumb.startsWith('http') && !thumb.endsWith('.svg') ? thumb : undefined,
      kind: isVideo ? 'video' : (isImage ? 'image' : 'file'),
    })
  }

  return {
    id: albumId,
    title,
    url,
    domain,
    files,
  }
}

export async function resolveBunkrFile(fileId: string, domain = 'bunkr.cr'): Promise<BunkrResolvedMedia> {
  const pageUrl = `https://${domain}/f/${fileId}`
  const pageRes = await httpFetch(
    pageUrl,
    {
      headers: {
        'User-Agent': DESKTOP_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    },
    8000,
  )

  if (!pageRes.ok) {
    throw new Error(`Bunkr file page fetch failed with status ${pageRes.status}`)
  }

  const html = await pageRes.text()

  // 1. Metadata from page
  const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                     html.match(/<title>([^<]+)<\/title>/i)
  const cleanTitle = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/\s*\|\s*Bunkr.*$/i, '').trim()) : `Bunkr_${fileId}`

  const thumbMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)
  const thumb = thumbMatch ? thumbMatch[1] : undefined

  // 2. Download button with data-id or link
  const dlIdMatch = html.match(/data-id="([0-9]+)"/i) || html.match(/\/file\/([0-9]+)/i)
  if (!dlIdMatch) {
    throw new Error('Could not find Bunkr download ID on page')
  }
  const numericId = dlIdMatch[1]

  // 3. Request metadata from API
  const metaRes = await httpFetch(
    'https://dl.bunkr.cr/api/_001_v2',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': DESKTOP_UA,
        'Referer': `https://dl.bunkr.cr/file/${numericId}`,
      },
      body: JSON.stringify({ id: numericId }),
    },
    8000,
  )

  if (!metaRes.ok) {
    throw new Error(`Bunkr API metadata fetch failed with status ${metaRes.status}`)
  }

  const meta: any = await metaRes.json()
  if (!meta?.path || !meta?.mediafiles) {
    throw new Error('Invalid metadata returned by Bunkr API')
  }

  // 4. Sign the path via sign service
  const signRes = await httpFetch(
    `https://glb-apisign.cdn.cr/sign?path=${encodeURIComponent(meta.path)}`,
    {
      headers: {
        'User-Agent': DESKTOP_UA,
      },
    },
    8000,
  )

  if (!signRes.ok) {
    throw new Error(`Bunkr signing service failed with status ${signRes.status}`)
  }

  const signData: any = await signRes.json()
  if (!signData?.token || !signData?.ex) {
    throw new Error('Invalid sign response from Bunkr')
  }

  const finalUrl = new URL(meta.mediafiles + meta.path)
  finalUrl.searchParams.set('token', signData.token)
  finalUrl.searchParams.set('ex', String(signData.ex))
  if (meta.original) {
    finalUrl.searchParams.set('n', meta.original)
  }

  const ext = meta.path.includes('.') ? meta.path.split('.').pop()!.toLowerCase() : 'mp4'

  return {
    id: fileId,
    title: meta.original || cleanTitle,
    thumb,
    directUrl: finalUrl.toString(),
    ext,
  }
}
