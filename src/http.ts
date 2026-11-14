export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

/** Instagram's private API rejects non-app user agents. */
export const IG_APP_UA =
  'Instagram 269.0.0.18.75 Android (33/13; 480dpi; 1080x2201; samsung; SM-G991B; o1s; exynos2100; en_US; 314665256)'

export async function httpFetch(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  return fetch(url, {
    redirect: 'follow',
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  })
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const response = await httpFetch(url, init, timeoutMs)
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`)
  return (await response.json()) as T
}

export async function fetchText(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<string> {
  const response = await httpFetch(url, init, timeoutMs)
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`)
  return await response.text()
}

/** Follows redirects (short links) and returns the final URL. */
export async function resolveFinalUrl(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<string> {
  const response = await httpFetch(url, init, timeoutMs)
  try {
    await response.body?.cancel()
  } catch {
    /* ignore */
  }
  return response.url || url
}

/**
 * Platforms embed URLs inside JSON with one or more layers of escaping
 * (Instagram's embed page uses ``https:\\\/\\\/...``). Collapse all of them.
 */
export function decodeEscapes(input: string): string {
  return input
    .replace(/\\+u002[fF]/g, '/')
    .replace(/\\+u0026/g, '&')
    .replace(/\\+u003[dD]/g, '=')
    .replace(/\\+u003[aA]/g, ':')
    .replace(/\\+u0025/g, '%')
    .replace(/\\+\//g, '/')
    .replace(/\\+"/g, '"')
    .replace(/\\+'/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

export function firstMatch(input: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = input.match(pattern)
    if (match?.[1]) return match[1]
  }
  return undefined
}
