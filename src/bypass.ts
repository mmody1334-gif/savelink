import { DESKTOP_UA, decodeEscapes } from './http'

export interface BypassResult {
  originalUrl: string
  finalUrl: string
  service?: string
  hops: number
  isAdLink: boolean
  success: boolean
  error?: string
}

const AD_DOMAINS = [
  'ouo.io',
  'ouo.press',
  'adf.ly',
  'ay.gy',
  'j.gs',
  'q.gs',
  'linkvertise.com',
  'linkvertise.net',
  'link-to.net',
  'up-to-down.net',
  'direct-link.net',
  'file-link.net',
  'shrinkme.io',
  'shrinkme.site',
  'droplink.co',
  'gplinks.co',
  'exe.io',
  'shorte.st',
  'sub2unlock.com',
  'sub2unlock.net',
  'rekonise.com',
  'mboost.me',
]

const SHORTENER_DOMAINS = [
  'bit.ly',
  'tinyurl.com',
  't.co',
  'cutt.ly',
  'is.gd',
  'rb.gy',
  'shorturl.at',
  'ow.ly',
  'trib.al',
  'buff.ly',
  'rebrand.ly',
  'zws.im',
  'v.gd',
  'soo.gd',
]

export function isShortenerOrAdLink(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      AD_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)) ||
      SHORTENER_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
    )
  } catch {
    return false
  }
}

/**
 * Extracts a URL embedded inside query parameters (URL-encoded or base64).
 */
export function extractEmbeddedUrl(urlStr: string): string | null {
  try {
    const parsed = new URL(urlStr)
    const paramKeys = ['url', 'dest', 'destination', 'target', 'link', 'r', 'go', 'u', 'next']

    for (const key of paramKeys) {
      const val = parsed.searchParams.get(key)
      if (!val) continue

      // 1. Direct URL in param
      if (/^https?:\/\//i.test(val)) {
        return val
      }

      // 2. Base64 encoded URL
      if (val.length >= 12 && /^[A-Za-z0-9+/=]+$/.test(val)) {
        try {
          const decoded = atob(val)
          if (/^https?:\/\//i.test(decoded)) {
            return decoded
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Decodes AdFly's obfuscated ysmm token.
 */
export function decodeAdfly(ysmm: string): string | null {
  try {
    let left = ''
    let right = ''
    for (let i = 0; i < ysmm.length; i++) {
      if (i % 2 === 0) {
        left += ysmm.charAt(i)
      } else {
        right = ysmm.charAt(i) + right
      }
    }

    const combined = (left + right).split('')
    for (let i = 0; i < combined.length; i++) {
      if (!isNaN(Number(combined[i]))) {
        for (let j = i + 1; j < combined.length; j++) {
          if (!isNaN(Number(combined[j]))) {
            const x = Number(combined[i]) ^ Number(combined[j])
            if (x < 10) {
              combined[i] = String(x)
            }
            i = j
            break
          }
        }
      }
    }

    const decoded = atob(combined.join(''))
    const finalUrl = decoded.slice(16, decoded.length - 16)
    if (/^https?:\/\//i.test(finalUrl)) {
      return finalUrl
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Unshortens a link and bypasses ad-link redirects to find the destination URL.
 */
export async function unshortenUrl(rawUrl: string, maxHops = 10): Promise<BypassResult> {
  const originalUrl = rawUrl.trim()
  let current = originalUrl.startsWith('http') ? originalUrl : `https://${originalUrl}`

  const isAdLink = AD_DOMAINS.some((d) => {
    try {
      const host = new URL(current).hostname.toLowerCase()
      return host === d || host.endsWith(`.${d}`)
    } catch {
      return false
    }
  })

  // Fast check: parameter-based redirect
  const embedded = extractEmbeddedUrl(current)
  if (embedded && embedded !== current) {
    return {
      originalUrl,
      finalUrl: embedded,
      hops: 1,
      isAdLink,
      success: true,
    }
  }

  // If it's a known complex ad wall (e.g. Linkvertise), try public bypass resolver
  if (/linkvertise\.(com|net)|link-to\.net|up-to-down\.net|direct-link\.net/i.test(current)) {
    try {
      const bypassApi = `https://bypass.pm/bypass2?url=${encodeURIComponent(current)}`
      const res = await fetch(bypassApi, {
        headers: { 'User-Agent': DESKTOP_UA },
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        const json = (await res.json()) as { destination?: string; success?: boolean }
        if (json.destination && /^https?:\/\//i.test(json.destination)) {
          return {
            originalUrl,
            finalUrl: json.destination,
            service: 'linkvertise',
            hops: 1,
            isAdLink: true,
            success: true,
          }
        }
      }
    } catch {
      /* fallback to standard resolution */
    }
  }

  let hops = 0
  const seen = new Set<string>()

  while (hops < maxHops) {
    hops++
    if (seen.has(current)) break
    seen.add(current)

    try {
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': DESKTOP_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ar,en-US;q=0.9',
        },
        signal: AbortSignal.timeout(10_000),
      })

      // 1. HTTP Redirect status (301, 302, 303, 307, 308)
      if (response.status >= 300 && response.status < 400) {
        const loc = response.headers.get('location')
        if (!loc) break
        current = new URL(loc, current).href
        continue
      }

      // 2. Body inspection on 200 OK
      if (response.ok) {
        const html = await response.text()

        // Check AdFly ysmm script
        const ysmmMatch = html.match(/var\s+ysmm\s*=\s*['"]([^'"]+)['"]/)
        if (ysmmMatch) {
          const adflyUrl = decodeAdfly(ysmmMatch[1])
          if (adflyUrl) {
            return {
              originalUrl,
              finalUrl: adflyUrl,
              service: 'adfly',
              hops,
              isAdLink: true,
              success: true,
            }
          }
        }

        // Meta refresh: <meta http-equiv="refresh" content="0;url=http://...">
        const metaRefreshMatch =
          html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d+;\s*url=([^"'>\s]+)/i) ||
          html.match(/<meta[^>]+content=["']?\d+;\s*url=([^"'>\s]+)["']?[^>]+http-equiv=["']?refresh/i)
        if (metaRefreshMatch) {
          current = new URL(decodeEscapes(metaRefreshMatch[1]), current).href
          continue
        }

        // JavaScript window.location redirect
        const jsRedirectMatch =
          html.match(/window\.location(?:\.replace|\.href)?\s*=\s*['"]([^'"]+)['"]/i) ||
          html.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i)
        if (jsRedirectMatch && /^https?:\/\//i.test(jsRedirectMatch[1])) {
          current = new URL(decodeEscapes(jsRedirectMatch[1]), current).href
          continue
        }

        // If we reached here, current URL is the terminal page
        break
      }

      break
    } catch (err) {
      return {
        originalUrl,
        finalUrl: current,
        hops,
        isAdLink,
        success: current !== originalUrl,
        error: (err as Error).message,
      }
    }
  }

  return {
    originalUrl,
    finalUrl: current,
    hops,
    isAdLink,
    success: current !== originalUrl,
  }
}
