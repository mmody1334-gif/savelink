import { EngineError } from './errors'
import { httpFetch } from './http'
import type { Env, MediaItem } from './types'

const FB_REFERER = 'https://www.facebook.com/'

// Persisted GraphQL doc_ids used by Facebook's own web app (the browser makes
// these exact calls when someone opens a profile and its highlights). Facebook
// rotates doc_ids between site builds; stale ids keep working for a while, but
// if these calls start failing, rediscover the current ids from the profile
// page's JS bundles (e.g. via https://github.com/brxxn/fbtm relay-operations).
//
// Why this exists: Facebook no longer embeds the highlights shelf in the
// server-rendered profile HTML. The shelf loads through deferred GraphQL, so
// the regex-over-HTML discovery finds nothing even with a valid session.
const FB_DOC_HIGHLIGHT_TILES = '9516333321764857'
const FB_DOC_STORY_BUCKET = '8367440913325249'

export function extractFbDtsg(html: string): string | undefined {
  return html.match(/"DTSGInitialData"[^}]*?"token":"([^"]+)"/)?.[1]
}

function fbViewerId(env: Env): string | undefined {
  return env.FB_COOKIE?.match(/(?:^|;\s*)c_user=(\d+)/)?.[1]
}

interface FbGraphqlOptions {
  docId: string
  variables: Record<string, unknown>
  dtsg: string
  referer?: string
  timeoutMs?: number
}

async function fbGraphqlPost(env: Env, opts: FbGraphqlOptions): Promise<string> {
  const viewerId = fbViewerId(env)
  if (!viewerId) {
    throw new EngineError(
      'Facebook session (FB_COOKIE) is missing c_user. Renew FB_COOKIE with a full cookie string.',
      'facebook-graphql',
      false,
    )
  }
  const body = new URLSearchParams()
  body.set('av', viewerId)
  body.set('__user', viewerId)
  body.set('__a', '1')
  body.set('__comet_req', '15')
  body.set('fb_dtsg', opts.dtsg)
  body.set('doc_id', opts.docId)
  body.set('variables', JSON.stringify(opts.variables))
  const res = await httpFetch(
    'https://www.facebook.com/api/graphql/',
    {
      method: 'POST',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.facebook.com',
        Referer: opts.referer ?? FB_REFERER,
        'Sec-Fetch-Site': 'same-origin',
        Cookie: env.FB_COOKIE || '',
      },
      body: body.toString(),
    },
    opts.timeoutMs ?? 15_000,
  )
  if (!res.ok) {
    throw new EngineError(`Facebook GraphQL request failed (HTTP ${res.status}).`, 'facebook-graphql', false)
  }
  return res.text()
}

/** Facebook answers GraphQL with JSONL: one JSON document per line. */
function parseJsonLines(raw: string): unknown[] {
  const docs: unknown[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      docs.push(JSON.parse(trimmed))
    } catch {
      // some payloads prefix the JSON with "for (;;);" - retry after stripping
      const idx = trimmed.indexOf('{')
      if (idx > 0) {
        try {
          docs.push(JSON.parse(trimmed.slice(idx)))
        } catch {
          /* ignore malformed line */
        }
      }
    }
  }
  if (!docs.length && raw.trim()) {
    try {
      docs.push(JSON.parse(raw))
    } catch {
      /* ignore */
    }
  }
  return docs
}

function findKey(root: unknown, key: string): unknown {
  const stack: unknown[] = [root]
  const seen = new Set<object>()
  while (stack.length) {
    const cur = stack.pop()
    if (!cur || typeof cur !== 'object') continue
    if (seen.has(cur as object)) continue
    seen.add(cur as object)
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v)
      continue
    }
    const rec = cur as Record<string, unknown>
    if (key in rec) return rec[key]
    for (const v of Object.values(rec)) stack.push(v)
  }
  return undefined
}

export interface FacebookHighlightCollection {
  id: string
  title?: string
  count?: number
}

export function parseHighlightCollections(raw: string): {
  collections: FacebookHighlightCollection[]
  hasNextPage: boolean
  endCursor?: string
} {
  const collections: FacebookHighlightCollection[] = []
  const seen = new Set<string>()
  let hasNextPage = false
  let endCursor: string | undefined
  for (const doc of parseJsonLines(raw)) {
    const items = findKey(doc, 'profile_tile_items') as
      | { edges?: Array<{ node?: { node?: Record<string, unknown> } }>; page_info?: { has_next_page?: boolean; end_cursor?: string } }
      | undefined
    if (!items || !Array.isArray(items.edges)) continue
    for (const edge of items.edges) {
      const node = edge?.node?.node
      if (!node || node.__typename !== 'StoryHighlightContainer') continue
      const id = String(node.id || '')
      if (!id || seen.has(id)) continue
      seen.add(id)
      collections.push({
        id,
        title: typeof node.name === 'string' ? node.name : undefined,
        count:
          typeof (node.highlighted_cards as { count?: unknown } | undefined)?.count === 'number'
            ? ((node.highlighted_cards as { count: number }).count as number)
            : undefined,
      })
    }
    if (items.page_info?.has_next_page && items.page_info.end_cursor) {
      hasNextPage = true
      endCursor = items.page_info.end_cursor
    }
  }
  return { collections, hasNextPage, endCursor }
}

/**
 * List a profile's story-highlight collections through the same GraphQL call
 * the web app makes for the highlights tray on a profile page.
 */
export async function fetchFacebookHighlightCollections(
  userId: string,
  dtsg: string,
  env: Env,
  maxPages = 5,
): Promise<FacebookHighlightCollection[]> {
  const tileViewId = btoa(
    `profile_tile_view:${userId}:intro:intro_featured_highlights_content:hscroll_cards:profile_timeline:3:7`,
  )
  const all: FacebookHighlightCollection[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const raw = await fbGraphqlPost(env, {
      docId: FB_DOC_HIGHLIGHT_TILES,
      dtsg,
      variables: { scale: 1, id: tileViewId, count: 50, cursor },
    })
    const { collections, hasNextPage, endCursor } = parseHighlightCollections(raw)
    for (const c of collections) {
      if (!seen.has(c.id)) {
        seen.add(c.id)
        all.push(c)
      }
    }
    if (!hasNextPage || !endCursor) break
    cursor = endCursor
  }
  return all
}

export function parseStoryBucketMedia(raw: string): MediaItem[] {
  const items: MediaItem[] = []
  const seen = new Set<string>()
  const push = (item: MediaItem) => {
    if (!item.url || seen.has(item.url)) return
    seen.add(item.url)
    items.push(item)
  }
  for (const doc of parseJsonLines(raw)) {
    const unified = findKey(doc, 'unified_stories') as { edges?: Array<{ node?: Record<string, unknown> }> } | undefined
    if (!unified || !Array.isArray(unified.edges)) continue
    for (const edge of unified.edges) {
      const node = edge?.node
      if (!node) continue
      const attachments = Array.isArray(node.attachments) ? (node.attachments as Array<Record<string, unknown>>) : []
      for (const att of attachments) {
        const media = att.media as Record<string, unknown> | undefined
        if (!media) continue
        const kind = (media.__isMedia as string) || (media.__typename as string)
        if (kind === 'Video') {
          const progressive = (
            ((media.videoDeliveryResponseFragment as Record<string, unknown> | undefined)
              ?.videoDeliveryResponseResult as Record<string, unknown> | undefined)
              ?.progressive_urls
          ) as Array<{ progressive_url?: string; metadata?: { quality?: string } }> | undefined
          if (!progressive?.length) continue
          const hd = progressive.find((p) => p.metadata?.quality === 'HD' && p.progressive_url)
          const best = hd || [...progressive].reverse().find((p) => p.progressive_url)
          if (!best?.progressive_url) continue
          push({
            kind: 'video',
            url: best.progressive_url,
            ext: 'mp4',
            mime: 'video/mp4',
            label: hd ? 'HD' : 'SD',
            referer: FB_REFERER,
          })
        } else if (kind === 'Photo') {
          const uri = (media.image as { uri?: string } | undefined)?.uri
          if (!uri) continue
          push({
            kind: 'image',
            url: uri,
            ext: 'jpg',
            mime: 'image/jpeg',
            label: 'Story Photo',
            referer: FB_REFERER,
          })
        }
      }
    }
  }
  return items
}

/**
 * Fetch every card of a story bucket (regular stories bucket or a highlight
 * collection) through the GraphQL call the stories viewer makes.
 */
export async function fetchStoryBucketMedia(bucketId: string, dtsg: string, env: Env): Promise<MediaItem[]> {
  const raw = await fbGraphqlPost(env, {
    docId: FB_DOC_STORY_BUCKET,
    dtsg,
    variables: { bucketID: bucketId, focusCommentID: null, scale: 1 },
    referer: `https://www.facebook.com/stories/${bucketId}/`,
  })
  return parseStoryBucketMedia(raw)
}
