import { EngineError } from './errors'
import { decodeEscapes, fetchText } from './http'
import { fbHeaders } from './facebook-profile'
import { extractFbDtsg, fetchStoryBucketMedia } from './facebook-graphql'
import type { Env, MediaItem } from './types'

/**
 * The stories/highlights pages are now JS shells with no media in the HTML.
 * The real cards come from the stories viewer's GraphQL bucket query, so try
 * that first (using the fb_dtsg token from the shell page) and only fall back
 * to scraping the HTML when the GraphQL path yields nothing.
 */
async function fetchBucketViaGraphql(bucketId: string, html: string, env: Env): Promise<MediaItem[]> {
  if (!env.FB_COOKIE) return []
  const dtsg = extractFbDtsg(html)
  if (!dtsg) return []
  try {
    return await fetchStoryBucketMedia(bucketId, dtsg, env)
  } catch {
    return []
  }
}

const FB_REFERER = 'https://www.facebook.com/'

export interface FacebookStoriesResult {
  items: MediaItem[]
  name?: string
}

export interface FacebookHighlightsResult {
  items: MediaItem[]
  title?: string
}

export function extractStoryMediaFromHtml(html: string): MediaItem[] {
  const items: MediaItem[] = []
  const seenUrls = new Set<string>()

  // 1. Look for HD/SD video playback URLs
  const videoMatches = [
    ...html.matchAll(/"playable_url_quality_hd":"([^"]+)"/g),
    ...html.matchAll(/"browser_native_hd_url":"([^"]+)"/g),
    ...html.matchAll(/"playable_url":"([^"]+)"/g),
    ...html.matchAll(/"browser_native_sd_url":"([^"]+)"/g),
  ]

  for (const match of videoMatches) {
    const raw = decodeEscapes(match[1])
    if (!seenUrls.has(raw)) {
      seenUrls.add(raw)
      items.push({
        kind: 'video',
        url: raw,
        ext: 'mp4',
        mime: 'video/mp4',
        label: raw.includes('hd') ? 'HD' : 'SD',
        referer: FB_REFERER,
      })
    }
  }

  // 2. Look for story photo attachments / cards
  const imageMatches = [
    ...html.matchAll(/"story_card_seen_state":\{[^}]+\},"story_overlays":\[[^\]]*\],"story_card_info":\{[^}]*?"uri":"(https:[^"]+)"/g),
    ...html.matchAll(/"story_card_info":\{[^}]*?"uri":"(https:[^"]+)"/g),
    ...html.matchAll(/"story_attachment":\{[^}]*?"uri":"(https:[^"]+)"/g),
  ]

  for (const match of imageMatches) {
    const raw = decodeEscapes(match[1]).replace(/\\/g, '')
    if (raw.includes('scontent') && !seenUrls.has(raw)) {
      seenUrls.add(raw)
      items.push({
        kind: 'image',
        url: raw,
        ext: 'jpg',
        mime: 'image/jpeg',
        label: 'Story Photo',
        referer: FB_REFERER,
      })
    }
  }

  // Fallback: If no direct video or card info matched, check for any viewer_image in story context
  if (!items.length) {
    const viewerMatches = [...html.matchAll(/"viewer_image":\{[^}]*?"uri":"(https:[^"]+)"/g)]
    for (const match of viewerMatches) {
      const raw = decodeEscapes(match[1]).replace(/\\/g, '')
      if (raw.includes('scontent') && !seenUrls.has(raw)) {
        seenUrls.add(raw)
        items.push({
          kind: 'image',
          url: raw,
          ext: 'jpg',
          mime: 'image/jpeg',
          label: 'Story Photo',
          referer: FB_REFERER,
        })
      }
    }
  }

  return items
}

export async function fetchFacebookStories(
  bucketIdOrUserId: string,
  env: Env,
): Promise<FacebookStoriesResult> {
  if (!env.FB_COOKIE) {
    throw new EngineError(
      'Facebook stories require a session (FB_COOKIE).',
      'facebook-stories',
      false,
    )
  }

  const url = `https://www.facebook.com/stories/${bucketIdOrUserId}/`
  let html: string
  try {
    html = await fetchText(url, { headers: fbHeaders(env) }, 15_000)
  } catch (error) {
    throw new EngineError(
      `Could not load Facebook stories (${(error as Error).message}).`,
      'facebook-stories',
      false,
    )
  }

  if (html.includes('login_attempt') || html.includes('id="login_form"')) {
    throw new EngineError(
      'Facebook session (FB_COOKIE) expired or could not access stories.',
      'facebook-stories',
      false,
    )
  }

  const graphqlItems = await fetchBucketViaGraphql(bucketIdOrUserId, html, env)
  const items = graphqlItems.length ? graphqlItems : extractStoryMediaFromHtml(html)
  const name =
    html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i)?.[1] ||
    html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]

  return {
    items,
    name: name ? decodeEscapes(name) : undefined,
  }
}

export async function fetchFacebookHighlights(
  highlightId: string,
  env: Env,
): Promise<FacebookHighlightsResult> {
  if (!env.FB_COOKIE) {
    throw new EngineError(
      'Facebook highlights require a session (FB_COOKIE).',
      'facebook-highlights',
      false,
    )
  }

  const url = `https://www.facebook.com/stories/highlights/${highlightId}/`
  let html: string
  try {
    html = await fetchText(url, { headers: fbHeaders(env) }, 15_000)
  } catch (error) {
    throw new EngineError(
      `Could not load Facebook highlights (${(error as Error).message}).`,
      'facebook-highlights',
      false,
    )
  }

  if (html.includes('login_attempt') || html.includes('id="login_form"')) {
    throw new EngineError(
      'Facebook session (FB_COOKIE) expired or could not access highlights.',
      'facebook-highlights',
      false,
    )
  }

  const graphqlItems = await fetchBucketViaGraphql(highlightId, html, env)
  const items = graphqlItems.length ? graphqlItems : extractStoryMediaFromHtml(html)
  const title =
    html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i)?.[1] ||
    html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]

  return {
    items,
    title: title ? decodeEscapes(title) : undefined,
  }
}
