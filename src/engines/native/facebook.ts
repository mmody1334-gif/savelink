import { EngineError } from '../../errors'
import { DESKTOP_UA, MOBILE_UA, decodeEscapes, fetchText, firstMatch, resolveFinalUrl } from '../../http'
import type { Env, MediaItem, MediaResult, ResolveInput } from '../../types'

const FB_REFERER = 'https://www.facebook.com/'

const FB_APP_UA =
  'Dalvik/2.1.0 (Linux; U; Android 14; SM-S928B Build/UP1A.231005.007) [FBAN/FB4A;FBAV/450.0.0.33.109;FBBV/565432100;FBDV/SM-S928B;FBMD/samsung;FBSN/Android;FBSV/14;FBSS/3;FBID/phone;FBLC/en_US;FBOP/19]'

interface FacebookSources {
  hd?: string
  sd?: string
}

function extractSources(html: string): FacebookSources {
  const decoded = decodeEscapes(html)
  const candidates = [decoded, html]

  for (const text of candidates) {
    const hd = firstMatch(text, [
      /"browser_native_hd_url":"([^"]+)"/,
      /"playable_url_quality_hd":"([^"]+)"/,
      /"hd_src(?:_no_ratelimit)?":"([^"]+)"/,
      /hd_src:"([^"]+)"/,
    ])
    const sd = firstMatch(text, [
      /"browser_native_sd_url":"([^"]+)"/,
      /"playable_url":"([^"]+)"/,
      /"sd_src(?:_no_ratelimit)?":"([^"]+)"/,
      /sd_src:"([^"]+)"/,
    ])
    if (hd || sd) {
      const cleanHd = hd ? hd.replace(/\\\//g, '/') : undefined
      const cleanSd = sd ? sd.replace(/\\\//g, '/') : undefined
      return { hd: cleanHd, sd: cleanSd }
    }
  }
  return {}
}

function pageTitle(html: string): string | undefined {
  const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i)?.[1]
  if (og) return decodeEscapes(og)
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
  return title ? decodeEscapes(title) : undefined
}

function pageThumb(html: string): string | undefined {
  const og = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/i)?.[1]
  if (og) return decodeEscapes(og).replace(/\\\//g, '/')
  const thumb = html.match(/"preferred_thumbnail":\{"image":\{"uri":"([^"]+)"/)?.[1]
  return thumb ? decodeEscapes(thumb).replace(/\\\//g, '/') : undefined
}

function buildResult(sources: FacebookSources, sourceUrl: string, html: string): MediaResult | null {
  const items: MediaItem[] = []
  if (sources.hd) items.push({ kind: 'video', url: sources.hd, ext: 'mp4', mime: 'video/mp4', height: 720, label: 'HD', referer: FB_REFERER })
  if (sources.sd && sources.sd !== sources.hd) items.push({ kind: 'video', url: sources.sd, ext: 'mp4', mime: 'video/mp4', height: 360, label: 'SD', referer: FB_REFERER })
  if (!items.length) return null
  return {
    platform: 'facebook',
    sourceUrl,
    title: pageTitle(html),
    thumbnail: pageThumb(html),
    items,
    engine: 'facebook',
  }
}

function extractFacebookId(input: string): string | undefined {
  try {
    const parsed = new URL(input)
    const vParam = parsed.searchParams.get('v')
    if (vParam && /^\d+$/.test(vParam)) return vParam
    const match = parsed.pathname.match(/\/(?:reel|videos?|watch)\/(\d+)/i)
    if (match) return match[1]
  } catch {}
  return undefined
}

export async function resolveFacebookShare(rawUrl: string): Promise<string> {
  let url = rawUrl
  const matchShare = url.match(/https?:\/\/(?:www\.|m\.)?facebook\.com\/share\/([a-z0-9/_-]+)/i)
  if (matchShare) {
    url = `https://www.facebook.com/share/${matchShare[1].replace(/\/+$/, '')}/`
  }

  // 1) Try following redirect with FB_APP_UA (bypasses Cloudflare IP 400 blocking on /share/)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': FB_APP_UA,
        Accept: '*/*',
      },
    })
    const loc = res.headers.get('location')
    if (loc) {
      return loc.split('#')[0]
    }
  } catch {}

  // 2) If /share/<id> without subpath, try /share/r/<id>/ and /share/v/<id>/
  const simpleMatch = url.match(/\/share\/([A-Za-z0-9]+)\/?$/)
  if (simpleMatch) {
    for (const prefix of ['r', 'v']) {
      try {
        const candidate = `https://www.facebook.com/share/${prefix}/${simpleMatch[1]}/`
        const res = await fetch(candidate, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'User-Agent': FB_APP_UA,
            Accept: '*/*',
          },
        })
        const loc = res.headers.get('location')
        if (loc) {
          return loc.split('#')[0]
        }
      } catch {}
    }
  }

  return url
}

export async function extractFacebook(input: ResolveInput, env: Env): Promise<MediaResult> {
  const baseHeaders: Record<string, string> = {
    'User-Agent': MOBILE_UA,
    'Accept-Language': 'en-US,en;q=0.9',
  }
  if (env.FB_COOKIE) baseHeaders.Cookie = env.FB_COOKIE

  let url = input.url

  // Resolve shortlinks (/share/ and fb.watch)
  if (/fb\.watch|\/share\//i.test(url)) {
    url = await resolveFacebookShare(url)
  }

  // Try standard resolveFinalUrl if still on a shortlink
  if (/fb\.watch|\/share\//i.test(url)) {
    try {
      url = await resolveFinalUrl(url, { headers: baseHeaders }, 8_000)
    } catch {}
  }

  const failures: string[] = []

  const desktopHeaders: Record<string, string> = {
    'User-Agent': DESKTOP_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Mode': 'navigate',
  }
  if (env.FB_COOKIE) desktopHeaders.Cookie = env.FB_COOKIE

  // 1) Direct Watch with _rdr (serves browser_native_hd_url and browser_native_sd_url)
  const videoId = extractFacebookId(url) || extractFacebookId(input.url)
  if (videoId) {
    try {
      const watchUrl = `https://www.facebook.com/watch/?v=${videoId}&_rdr`
      let html = await fetchText(watchUrl, { headers: desktopHeaders }, 15_000)
      if (html.includes('checkpoint') && env.FB_COOKIE) {
        // Cookie triggered security checkpoint, retry cleanly without cookie
        const cleanHeaders = { ...desktopHeaders }
        delete cleanHeaders.Cookie
        html = await fetchText(watchUrl, { headers: cleanHeaders }, 15_000)
      }
      const result = buildResult(extractSources(html), input.url, html)
      if (result) return result
      failures.push('watch: no video sources')
    } catch (error) {
      failures.push(`watch: ${(error as Error).message}`)
    }
  }

  // 2) Fetch the resolved page directly with Desktop UA
  try {
    let html = await fetchText(url, { headers: desktopHeaders }, 15_000)
    if (html.includes('checkpoint') && env.FB_COOKIE) {
      const cleanHeaders = { ...desktopHeaders }
      delete cleanHeaders.Cookie
      html = await fetchText(url, { headers: cleanHeaders }, 15_000)
    }
    const result = buildResult(extractSources(html), input.url, html)
    if (result) return result
    failures.push('direct: no video sources')
  } catch (error) {
    failures.push(`direct: ${(error as Error).message}`)
  }

  // 3) Public video plugin endpoint.
  try {
    const plugin = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false&width=1280`
    const html = await fetchText(plugin, { headers: desktopHeaders }, 15_000)
    const result = buildResult(extractSources(html), input.url, html)
    if (result) return result
    failures.push('plugin: no video sources')
  } catch (error) {
    failures.push(`plugin: ${(error as Error).message}`)
  }

  // 4) mbasic
  try {
    const parsed = new URL(url)
    const mbasic = `https://mbasic.facebook.com${parsed.pathname}${parsed.search}`
    const html = await fetchText(mbasic, { headers: baseHeaders }, 15_000)
    const result = buildResult(extractSources(html), input.url, html)
    if (result) return result
    failures.push('mbasic: no video sources')
  } catch (error) {
    failures.push(`mbasic: ${(error as Error).message}`)
  }

  // 5) Photo extraction (ONLY if not a video/reel URL to prevent returning thumbnail as photo)
  const isVideoTarget = /reel|watch|videos|\/v\/|\/r\//i.test(input.url) || /reel|watch|videos/i.test(url)
  if (!isVideoTarget) {
    try {
      const html = await fetchText(url, { headers: desktopHeaders }, 15_000)
      const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/i)?.[1]
      let photoUrl = ogImage ? decodeEscapes(ogImage) : undefined

      if (!photoUrl) {
        const match =
          html.match(/"(?:viewer_image|display_resources)":\{"uri":"(https:[^"]+)"/) ||
          html.match(/"image":\{"uri":"(https:[^"]+)"/)
        if (match) photoUrl = decodeEscapes(match[1]).replace(/\\/g, '')
      }

      if (photoUrl && photoUrl.includes('scontent') && !photoUrl.includes('/rsrc.php/')) {
        return {
          platform: 'facebook',
          sourceUrl: input.url,
          title: pageTitle(html),
          thumbnail: photoUrl,
          items: [
            {
              kind: 'image',
              url: photoUrl,
              ext: 'jpg',
              mime: 'image/jpeg',
              label: 'Photo',
              referer: FB_REFERER,
            },
          ],
          engine: 'facebook',
        }
      }
      failures.push('photo: no image found')
    } catch (error) {
      failures.push(`photo: ${(error as Error).message}`)
    }
  }

  throw new EngineError(
    `Facebook extraction failed (${failures.join('; ')}). Public videos work best; private ones need FB_COOKIE or the yt-dlp engine.`,
    'facebook',
  )
}
