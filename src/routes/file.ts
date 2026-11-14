import { Hono } from 'hono'
import { maxProxyBytes } from '../config'
import { contentDisposition, verifyFileToken } from '../files'
import { DESKTOP_UA, httpFetch } from '../http'
import type { Env } from '../types'

export const fileRoute = new Hono<{ Bindings: Env }>()

/**
 * Signed download proxy. Upstream CDN links expire and are often hotlink
 * protected, so we hand Telegram (and the user) a short-lived signed URL
 * instead of the raw CDN URL.
 */
fileRoute.get('/file', async (c) => {
  const token = c.req.query('t')
  if (!token) return c.text('Missing token', 400)

  const payload = await verifyFileToken(token, c.env)
  if (!payload) return c.text('Invalid or expired link', 403)

  const limit = maxProxyBytes(c.env)
  if (payload.s && payload.s > limit) return c.text('File too large', 413)

  const headers: Record<string, string> = { 'User-Agent': DESKTOP_UA, Accept: '*/*' }
  if (payload.r) headers.Referer = payload.r
  const range = c.req.header('range')
  if (range) headers.Range = range

  const upstream = await httpFetch(payload.u, { headers }, 90_000)
  if (!upstream.ok && upstream.status !== 206) return c.text(`Upstream ${upstream.status}`, 502)

  const declared = Number(upstream.headers.get('content-length') ?? 0)
  if (declared && declared > limit) {
    await upstream.body?.cancel().catch(() => undefined)
    return c.text('File too large', 413)
  }

  const out = new Headers()
  out.set('content-type', payload.m ?? upstream.headers.get('content-type') ?? 'application/octet-stream')
  out.set('content-disposition', contentDisposition(payload.n ?? 'savelink-download'))
  out.set('cache-control', 'private, max-age=0, no-store')
  out.set('accept-ranges', 'bytes')
  const contentRange = upstream.headers.get('content-range')
  if (contentRange) out.set('content-range', contentRange)
  if (declared) out.set('content-length', String(declared))

  return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers: out })
})
