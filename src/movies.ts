import { EngineError } from './errors'
import { DESKTOP_UA, decodeEscapes, fetchText } from './http'
import type { Env } from './types'

export interface MovieSearchResult {
  id: string
  title: string
  url: string
  kind: 'movie' | 'series'
  poster?: string
  year?: string
  rating?: string
}

export interface MovieQualityOption {
  streamId: string
  itemId: string
  slug: string
  quality: string
  size?: string
  watchUrl: string
  downloadUrl: string
  directVideoUrl?: string
}

export interface MovieEpisode {
  id: string
  number: number
  title: string
  url: string
}

export interface MovieItemDetails {
  id: string
  title: string
  url: string
  kind: 'movie' | 'series'
  poster?: string
  year?: string
  rating?: string
  story?: string
  qualities: MovieQualityOption[]
  episodes: MovieEpisode[]
}

export interface ResolvedStream {
  quality: string
  size?: string
  directVideoUrl: string
  fileName?: string
}

const AKWAM_BASE = 'https://akwam.ss'

function akwamHeaders(): Record<string, string> {
  return {
    'User-Agent': DESKTOP_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ar,en-US;q=0.9',
    Referer: `${AKWAM_BASE}/`,
  }
}

const FILLER_WORDS = new Set([
  'marvel',
  'مارفل',
  'disney',
  'ديزني',
  'netflix',
  'نتفلكس',
  'نتفليكس',
  'dc',
  'دي سي',
  'فيلم',
  'مسلسل',
  'movie',
  'film',
  'series',
])

const POPULAR_ALIASES: Record<string, string> = {
  'ثانوس': 'Avengers Endgame',
  'thanos': 'Avengers Endgame',
  'اندجيم': 'Endgame',
  'اند جيم': 'Endgame',
  'مارفل اندجيم': 'Avengers Endgame',
  'marvel endgame': 'Avengers Endgame',
  'انفنتي وور': 'Avengers Infinity War',
  'انفينيتي وور': 'Avengers Infinity War',
  'infinity war': 'Avengers Infinity War',
  'افنجرز': 'Avengers',
  'avengers': 'Avengers',
  'سبايدر مان': 'Spider-Man',
  'سبايدرمان': 'Spider-Man',
  'spiderman': 'Spider-Man',
  'باتمان': 'Batman',
  'الرجل الوطواط': 'Batman',
  'سوبرمان': 'Superman',
  'سوبر مان': 'Superman',
  'ديدبول': 'Deadpool',
  'ولفرين': 'Wolverine',
  'جون ويك': 'John Wick',
  'فاست اند فيورس': 'Fast & Furious',
  'فاست اند فيريوس': 'Fast & Furious',
  'هاري بوتر': 'Harry Potter',
  'سيد الخواتم': 'Lord of the Rings',
  'صراع العروش': 'Game of Thrones',
  'قيم اوف ثرونز': 'Game of Thrones',
  'بريكنج باد': 'Breaking Bad',
  'بيكي بلاندرز': 'Peaky Blinders',
  'سترينجر ثينقز': 'Stranger Things',
  'فايكنج': 'Vikings',
  'فايكنجز': 'Vikings',
  'بريزون بريك': 'Prison Break',
  'ذا بويز': 'The Boys',
}

/**
 * Builds smart expanded queries for fuzzy movie and series search.
 */
export function buildSmartQueries(query: string): string[] {
  const trimmed = query.trim()
  if (!trimmed) return []

  const qLower = trimmed.toLowerCase()
  const queries: string[] = [trimmed]

  // Check alias dictionary
  for (const [alias, mapped] of Object.entries(POPULAR_ALIASES)) {
    if (qLower === alias || qLower.includes(alias)) {
      if (!queries.includes(mapped)) queries.push(mapped)
    }
  }

  // Strip filler words (e.g. "marvel endgame" -> "endgame")
  const tokens = qLower.split(/\s+/).filter((w) => !FILLER_WORDS.has(w))
  if (tokens.length > 0 && tokens.length < qLower.split(/\s+/).length) {
    const stripped = tokens.join(' ')
    if (!queries.includes(stripped)) queries.push(stripped)
  }

  return queries
}

export function scoreMovieItem(item: MovieSearchResult, terms: Set<string>): number {
  const tLower = item.title.toLowerCase()
  let score = 0

  for (const term of terms) {
    if (!term || term.length < 2) continue
    if (tLower.includes(term)) {
      score += 15
      // Exact word boundary bonus
      const wordRegex = new RegExp(`(^|\\s|[:\\-_])${term}($|\\s|[:\\-_])`, 'i')
      if (wordRegex.test(tLower)) {
        score += 20
      }
    }
  }

  // Boost for Endgame / Avengers co-occurrence
  if (terms.has('endgame') && tLower.includes('endgame')) {
    score += 50
    if (tLower.includes('avengers')) score += 50
  }

  return score
}

/**
 * Searches Akwam for Arabic/foreign movies and series using smart multi-query expansion and ranking.
 */
export async function searchMovies(query: string, _env?: Env): Promise<MovieSearchResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const queries = buildSmartQueries(trimmed)
  const seenIds = new Set<string>()
  const allResults: MovieSearchResult[] = []

  // Execute queries in parallel
  const searchPromises = queries.map(async (q) => {
    const searchUrl = `${AKWAM_BASE}/search?q=${encodeURIComponent(q)}`
    try {
      const html = await fetchText(searchUrl, { headers: akwamHeaders() }, 15_000)
      return parseAkwamSearchResults(html)
    } catch {
      return []
    }
  })

  const resultsByQuery = await Promise.allSettled(searchPromises)
  for (const res of resultsByQuery) {
    if (res.status === 'fulfilled') {
      for (const item of res.value) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id)
          allResults.push(item)
        }
      }
    }
  }

  if (!allResults.length) return []

  // Collect terms for scoring
  const terms = new Set<string>()
  for (const q of queries) {
    for (const word of q.toLowerCase().split(/[\s:\-_]+/)) {
      if (word.length >= 2 && !FILLER_WORDS.has(word)) {
        terms.add(word)
      }
    }
  }

  // Sort by relevance score
  allResults.sort((a, b) => scoreMovieItem(b, terms) - scoreMovieItem(a, terms))

  return allResults.slice(0, 10)
}

/**
 * Parses search results from Akwam search HTML.
 */
export function parseAkwamSearchResults(html: string): MovieSearchResult[] {
  const results: MovieSearchResult[] = []
  const entryBoxes = html.match(/<div class="entry-box[^"]*">[\s\S]*?<\/div>\s*<\/div>/g) || []

  for (const box of entryBoxes) {
    const linkMatch = box.match(/href="(https:\/\/akwam\.ss\/(movie|series)\/(\d+)\/([^"]*))"/)
    if (!linkMatch) continue

    const fullUrl = linkMatch[1]
    const kind = linkMatch[2] as 'movie' | 'series'
    const id = linkMatch[3]

    // Title
    const titleMatch =
      box.match(/<h3[^>]*class="entry-title[^"]*"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/i) ||
      box.match(/<h3[^>]*>\s*<a[^>]*>([^<]+)<\/a>/i) ||
      box.match(/alt="([^"]+)"/i)
    const title = titleMatch ? decodeEscapes(titleMatch[1]).trim() : ''
    if (!title) continue

    // Poster
    const posterMatch = box.match(/data-src="(https:\/\/img\.downet\.net\/[^"]+)"/i) ||
      box.match(/src="(https:\/\/img\.downet\.net\/[^"]+)"/i)
    const poster = posterMatch ? posterMatch[1] : undefined

    // Rating & Year
    const ratingMatch = box.match(/<span class="label rating"[^>]*>[\s\S]*?([0-9.]+)\s*<\/span>/i)
    const rating = ratingMatch ? ratingMatch[1].trim() : undefined

    const yearMatch = box.match(/<span class="badge badge-pill badge-secondary[^"]*"[^>]*>\s*(\d{4})\s*<\/span>/i)
    const year = yearMatch ? yearMatch[1].trim() : undefined

    results.push({
      id: `${kind}:${id}`,
      title,
      url: fullUrl,
      kind,
      poster,
      year,
      rating,
    })

    if (results.length >= 10) break
  }

  return results
}

/**
 * Parses movie or series details page.
 */
export async function getMovieDetails(url: string, _env?: Env): Promise<MovieItemDetails> {
  let html: string
  try {
    html = await fetchText(url, { headers: akwamHeaders() }, 15_000)
  } catch (error) {
    throw new EngineError(
      `Could not load movie details (${(error as Error).message}).`,
      'movies',
      false,
    )
  }

  return parseAkwamDetails(html, url)
}

/**
 * Parses movie details and available quality download/watch links.
 */
export function parseAkwamDetails(html: string, pageUrl: string): MovieItemDetails {
  const isSeries = pageUrl.includes('/series/') || html.includes('/episode/')
  const kind: 'movie' | 'series' = isSeries ? 'series' : 'movie'

  const idMatch = pageUrl.match(/\/(movie|series)\/(\d+)/)
  const rawId = idMatch ? idMatch[2] : ''
  const id = `${kind}:${rawId}`

  // Title
  const titleMatch =
    html.match(/<h1[^>]*class="entry-title[^"]*"[^>]*>([^<]+)<\/h1>/i) ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i)
  let title = titleMatch ? decodeEscapes(titleMatch[1]).replace(/\s*\|\s*اكوام.*$/i, '').trim() : 'Media'

  // Poster
  const posterMatch = html.match(/<picture>[\s\S]*?<img[^>]+(?:src|data-src)="(https:\/\/img\.downet\.net\/[^"]+)"/i) ||
    html.match(/<img[^>]+(?:src|data-src)="(https:\/\/img\.downet\.net\/[^"]+)"/i)
  const poster = posterMatch ? posterMatch[1] : undefined

  // Year & Rating
  const yearMatch = html.match(/السنة\s*:\s*(\d{4})/i) || html.match(/>(\d{4})<\/span>/i)
  const year = yearMatch ? yearMatch[1].trim() : undefined

  const ratingMatch = html.match(/10\s*\/\s*([0-9.]+)/i) || html.match(/rating"[^>]*>[\s\S]*?([0-9.]+)/i)
  const rating = ratingMatch ? ratingMatch[1].trim() : undefined

  // Story
  let story: string | undefined
  const storyWidgetMatch = html.match(/قصة[\s\S]*?<\/h2>[\s\S]*?<div class="widget-body[^"]*">([\s\S]*?)<\/div>/i)
  if (storyWidgetMatch) {
    story = storyWidgetMatch[1].replace(/<[^>]+>/g, '').trim()
  } else {
    const generalStoryMatch = html.match(/<p class="text-white[^"]*">([\s\S]*?)<\/p>/i)
    if (generalStoryMatch) {
      story = generalStoryMatch[1].replace(/<[^>]+>/g, '').trim()
    }
  }

  // Qualities (for movies or episodes)
  const qualities: MovieQualityOption[] = []
  const watchLinkRegex = /href="(https:\/\/akwam\.ss\/watch\/(\d+)\/(\d+)\/([^"]*))"/g
  let wMatch: RegExpExecArray | null
  const seenStreams = new Set<string>()

  while ((wMatch = watchLinkRegex.exec(html)) !== null) {
    const watchUrl = wMatch[1]
    const streamId = wMatch[2]
    const itemId = wMatch[3]
    const slug = wMatch[4]
    if (seenStreams.has(streamId)) continue
    seenStreams.add(streamId)

    const downloadUrl = `https://akwam.ss/download/${streamId}/${itemId}/${slug}`

    // Find quality and size near this download button in html
    let quality = '720p'
    let size: string | undefined

    const dlButtonRegex = new RegExp(
      `href="https:\\/\\/akwam\\.ss\\/download\\/${streamId}\\/${itemId}\\/[^"]*"[^>]*>([\\s\\S]*?)<\\/a>`,
      'i',
    )
    const dlMatch = html.match(dlButtonRegex)
    if (dlMatch) {
      const btnText = dlMatch[1].replace(/<[^>]+>/g, '').trim()
      const sizeMatch = btnText.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|KB|جيجا|ميجابايت))/i)
      if (sizeMatch) size = sizeMatch[1]
    }

    // Try finding quality badge near stream (closest preceding quality tag)
    const beforeSnippet = html.slice(Math.max(0, wMatch.index - 200), wMatch.index)
    const afterSnippet = html.slice(wMatch.index, Math.min(html.length, wMatch.index + 200))
    const qBeforeMatches = [...beforeSnippet.matchAll(/(1080p|720p|480p|360p|FHD|HD|SD|4K|2160p)/gi)]
    const qBefore = qBeforeMatches.length ? qBeforeMatches[qBeforeMatches.length - 1][1] : undefined
    const qAfter = afterSnippet.match(/(1080p|720p|480p|360p|FHD|HD|SD|4K|2160p)/i)?.[1]
    const chosenQuality = qBefore || qAfter

    if (chosenQuality) {
      quality = chosenQuality.toUpperCase()
    } else if (qualities.length === 0) {
      quality = '1080p FHD'
    } else if (qualities.length === 1) {
      quality = '720p HD'
    } else {
      quality = '480p SD'
    }

    qualities.push({
      streamId,
      itemId,
      slug,
      quality,
      size,
      watchUrl,
      downloadUrl,
    })
  }

  // Episodes (if series)
  const episodes: MovieEpisode[] = []
  if (isSeries) {
    const epRegex = /href="(https:\/\/akwam\.ss\/episode\/(\d+)\/[^"]*\/[^\d"]*(\d+))"/g
    let epMatch: RegExpExecArray | null
    const seenEpisodes = new Set<string>()

    while ((epMatch = epRegex.exec(html)) !== null) {
      const epUrl = epMatch[1]
      const epId = epMatch[2]
      const epNumber = Number(epMatch[3]) || 1
      if (seenEpisodes.has(epId)) continue
      seenEpisodes.add(epId)

      episodes.push({
        id: epId,
        number: epNumber,
        title: `الحلقة ${epNumber}`,
        url: epUrl,
      })
    }

    // Sort episodes ascending
    episodes.sort((a, b) => a.number - b.number)
  }

  return {
    id,
    title,
    url: pageUrl,
    kind,
    poster,
    year,
    rating,
    story,
    qualities,
    episodes,
  }
}

/**
 * Resolves direct CDN .mp4 URL from a watch page or download page.
 */
export async function resolveAkwamStream(watchUrl: string, _env?: Env): Promise<ResolvedStream> {
  let html: string
  try {
    html = await fetchText(watchUrl, { headers: akwamHeaders() }, 15_000)
  } catch (error) {
    throw new EngineError(
      `Could not load streaming page (${(error as Error).message}).`,
      'movies',
      false,
    )
  }

  // 1. Look for <source src="https://...mp4">
  const sourceMatches = [
    ...html.matchAll(/<source[^>]+src="(https:\/\/[^"]+\.mp4[^"]*)"/gi),
    ...html.matchAll(/<video[^>]+src="(https:\/\/[^"]+\.mp4[^"]*)"/gi),
    ...html.matchAll(/(https:\/\/[a-z0-9]+\.downet\.net\/download\/[^\s"'<>]+\.mp4)/gi),
  ]

  let directVideoUrl: string | undefined
  for (const m of sourceMatches) {
    if (m && m[1]) {
      directVideoUrl = m[1].replace(/#Intent;.*$/i, '')
      break
    }
  }

  if (!directVideoUrl) {
    // Fallback: check download page
    const downloadUrl = watchUrl.replace('/watch/', '/download/')
    try {
      const dlHtml = await fetchText(downloadUrl, { headers: akwamHeaders() }, 15_000)
      const dlMatch = dlHtml.match(/href="(https:\/\/[a-z0-9]+\.downet\.net\/download\/[^\s"'<>]+\.mp4)"/i)
      if (dlMatch) {
        directVideoUrl = dlMatch[1]
      }
    } catch {
      /* ignore */
    }
  }

  if (!directVideoUrl) {
    throw new EngineError(
      'Could not extract direct video stream for this quality.',
      'movies',
      false,
    )
  }

  // Extract file name and quality from CDN URL if present
  let fileName = ''
  try {
    fileName = decodeURIComponent(new URL(directVideoUrl).pathname.split('/').pop() || '')
  } catch {}

  const qualityMatch = fileName.match(/(1080p|720p|480p|360p|4K)/i)
  const quality = qualityMatch ? qualityMatch[1].toUpperCase() : 'HD'

  return {
    quality,
    directVideoUrl,
    fileName,
  }
}
