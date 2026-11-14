#!/usr/bin/env node
/**
 * Local Instagram session check.
 * Reads IG_COOKIE from .dev.vars (or the shell env) and calls the same
 * endpoints the Worker uses, but from THIS machine's IP.
 *
 *   node scripts/check-cookie.mjs
 *   node scripts/check-cookie.mjs natgeo
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const APP_UA =
  'Instagram 269.0.0.18.75 Android (33/13; 480dpi; 1080x2201; samsung; SM-G991B; o1s; exynos2100; en_US; 314665256)'

function loadDotEnv() {
  const file = resolve(process.cwd(), '.dev.vars')
  const values = {}
  if (!existsSync(file)) return values
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!match) continue
    values[match[1]] = match[2].replace(/^["']|["']$/g, '').trim()
  }
  return values
}

const env = { ...loadDotEnv(), ...process.env }
const cookie = env.IG_COOKIE ?? ''
const username = process.argv[2] ?? 'natgeo'

if (!cookie) {
  console.error('\nIG_COOKIE is empty. Add it to .dev.vars or export it.\n')
  process.exit(1)
}

function cookieValue(name) {
  const part = cookie.split(/;\s*/).find((entry) => entry.startsWith(`${name}=`))
  return part?.slice(name.length + 1) ?? ''
}

const dsUserId = cookieValue('ds_user_id')
const csrf = cookieValue('csrftoken')

async function call(url, { appUa = false, manual = false } = {}) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': appUa ? APP_UA : DESKTOP_UA,
        'x-ig-app-id': '936619743392459',
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.instagram.com/',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': csrf,
        Cookie: cookie,
      },
      redirect: manual ? 'manual' : 'follow',
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    return { status: response.status, body, bytes: text.length, location: response.headers.get('location') }
  } catch (error) {
    return { status: 0, body: null, bytes: 0, error: String(error).slice(0, 160) }
  }
}

const rows = []

function summary(result) {
  const body = result.body
  if (!body) return `html ${result.bytes}b`
  if (body.user) return `user @${body.user.username}`
  if (body.data?.user) return `profile @${body.data.user.username}`
  if (body.reels) return `reels:${Object.keys(body.reels).length}`
  if (Array.isArray(body.reels_media)) return `reels_media:${body.reels_media.length}`
  if (Array.isArray(body.tray)) return `tray:${body.tray.length}`
  if (Array.isArray(body.items)) return `items:${body.items.length}`
  const keys = Object.keys(body)
  const bits = []
  if (body.status) bits.push(String(body.status))
  if (body.message) bits.push(String(body.message))
  return bits.length ? bits.join(' ') : `keys:${keys.slice(0, 4).join(',')}`
}

async function check(label, url) {
  const [www, app] = await Promise.all([call(url), call(url, { appUa: true })])
  rows.push({
    check: label,
    www: www.status || www.error,
    app: app.status || app.error,
    wwwBody: summary(www),
    appBody: summary(app),
  })
}

console.log(`\nSession: ${cookie.length} bytes | ds_user_id=${dsUserId || 'MISSING'}\n`)

const me = await call('https://www.instagram.com/api/v1/accounts/current_user/?edit=true', { manual: true })
const meUser = me.body?.user?.username
console.log(
  meUser
    ? `OK: session VALID on this machine (logged in as @${meUser})`
    : `FAIL: session NOT accepted on this machine (status ${me.status}${me.location ? ` -> ${me.location}` : ''})`,
)
console.log('')

await check('web_profile_info', `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`)
await check('feed/user', `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(dsUserId)}/?count=17`)
await check('reels_media', `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(dsUserId)}`)
await check('highlights_tray', `https://www.instagram.com/api/v1/highlights/${encodeURIComponent(dsUserId)}/highlights_tray/`)

console.table(rows)

console.log(
  meUser
    ? '\nThe cookie works from your IP. If the Worker still gets 403/404, Instagram blocks\nCloudflare egress IPs for the private API; the account needs a residential proxy.\n'
    : '\nThe cookie is stale or was copied from a logged-out tab. Re-login on instagram.com,\nthen copy the full cookie header again from /api/v1/accounts/current_user/?edit=true.\n',
)
