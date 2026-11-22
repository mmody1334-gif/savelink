import { EngineError } from './errors'
import { DESKTOP_UA, fetchText, httpFetch } from './http'
import type { Env } from './types'

let cachedDtsg: { token: string; expiresAt: number } | null = null

export function clearDtsgCache(): void {
  cachedDtsg = null
}

export async function getFbDtsg(env: Env): Promise<string> {
  const now = Date.now()
  if (cachedDtsg && cachedDtsg.expiresAt > now) {
    return cachedDtsg.token
  }

  const headers: Record<string, string> = {
    'User-Agent': DESKTOP_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  }
  if (env.IG_COOKIE) headers.Cookie = env.IG_COOKIE

  let html: string
  try {
    html = await fetchText('https://www.instagram.com/', { headers }, 15_000)
  } catch (err) {
    throw new EngineError(`Instagram home page unreachable: ${(err as Error).message}`, 'instagram-graphql')
  }

  const token =
    html.match(/\["DTSGInitialData",\[\],\{"token":"([^"]+)"/)?.[1] ||
    html.match(/"DTSGInitData",\[\],\{"token":"([^"]+)"/)?.[1] ||
    html.match(/name="fb_dtsg" value="([^"]+)"/)?.[1]

  if (!token) {
    throw new EngineError(
      'Could not extract Instagram session token (fb_dtsg). The IG_COOKIE may have expired.',
      'instagram-graphql',
      false,
    )
  }

  cachedDtsg = { token, expiresAt: now + 60 * 60 * 1000 }
  return token
}

export async function queryInstagramGraphQL<T>(options: {
  friendlyName: string
  docId: string
  variables: Record<string, unknown>
  env: Env
  referer?: string
}): Promise<T> {
  if (!options.env.IG_COOKIE) {
    throw new EngineError('An Instagram session (IG_COOKIE) is required.', 'instagram-graphql', false)
  }

  const dtsg = await getFbDtsg(options.env)
  const csrf = options.env.IG_COOKIE.match(/csrftoken=([^;]+)/)?.[1] || ''

  const body = new URLSearchParams({
    fb_api_req_friendly_name: options.friendlyName,
    variables: JSON.stringify(options.variables),
    doc_id: options.docId,
    fb_dtsg: dtsg,
  })

  const headers: Record<string, string> = {
    'User-Agent': DESKTOP_UA,
    Cookie: options.env.IG_COOKIE,
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-IG-App-ID': '936619743392459',
    'X-CSRFToken': csrf,
    'X-FB-Friendly-Name': options.friendlyName,
    'X-ASBD-ID': '359341',
    Referer: options.referer || 'https://www.instagram.com/',
    Origin: 'https://www.instagram.com',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  }

  let response: Response
  try {
    response = await httpFetch(
      'https://www.instagram.com/api/graphql',
      {
        method: 'POST',
        headers,
        body: body.toString(),
      },
      15_000,
    )
  } catch (err) {
    throw new EngineError(`Instagram GraphQL network error: ${(err as Error).message}`, 'instagram-graphql')
  }

  if (response.status === 401 || response.status === 403) {
    cachedDtsg = null
    throw new EngineError(
      `Instagram refused the session (HTTP ${response.status}). The IG_COOKIE expired or Instagram blocks it from Cloudflare servers.`,
      'instagram-graphql',
      false,
    )
  }

  if (!response.ok) {
    throw new EngineError(`Instagram GraphQL responded HTTP ${response.status}`, 'instagram-graphql')
  }

  // A session Instagram does not trust is redirected to the login page, which
  // arrives as HTTP 200 text/html. Parsing that as JSON used to throw a bare
  // SyntaxError; name it so logs and fallbacks see the real cause.
  const contentType = response.headers?.get?.('content-type') || ''
  if (contentType.includes('text/html')) {
    throw new EngineError(
      'Instagram GraphQL answered with a page instead of JSON (login wall). The IG_COOKIE may be expired or blocked from this server.',
      'instagram-graphql',
      false,
    )
  }

  const json = (await response.json()) as any
  if (!json?.data && json?.errors?.length) {
    const msg = json.errors.map((e: any) => e.message || JSON.stringify(e)).join('; ')
    throw new EngineError(`Instagram GraphQL error: ${msg}`, 'instagram-graphql')
  }

  return json as T
}
