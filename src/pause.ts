import type { Env } from './types'

/**
 * Global kill switch. `/stopall` sets it, `/resumeall` clears it.
 * Stored in KV with no expiry so it survives until explicitly cleared.
 * A short in-memory memo keeps the check from costing a KV read per request.
 */
export const PAUSE_KEY = 'paused:all'
const MEMO_MS = 15_000

let memo: { value: boolean; at: number } | null = null

export async function isPaused(env: Env): Promise<boolean> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.value
  const value = env.CACHE ? Boolean(await env.CACHE.get(PAUSE_KEY)) : Boolean(memo?.value)
  memo = { value, at: Date.now() }
  return value
}

export async function setPaused(env: Env, paused: boolean, by?: number | string): Promise<void> {
  if (env.CACHE) {
    if (paused) await env.CACHE.put(PAUSE_KEY, JSON.stringify({ by: by ?? null, at: Date.now() }))
    else await env.CACHE.delete(PAUSE_KEY)
  }
  memo = { value: paused, at: Date.now() }
}

/** True when OWNER_ID lists at least one Telegram user id. */
export function isPauseConfigured(env: Env): boolean {
  return Boolean((env.OWNER_ID || '').trim())
}

/**
 * OWNER_ID (comma-separated Telegram user ids) limits who may pause/resume.
 * Unset = NOBODY: a missing OWNER_ID must never leave the kill-switch open
 * to every Telegram user. Set it with `wrangler secret put OWNER_ID`.
 */
export function canControlPause(env: Env, userId?: number): boolean {
  const raw = (env.OWNER_ID || '').trim()
  if (!raw) return false
  if (userId == null) return false
  return raw.split(',').map((s) => s.trim()).includes(String(userId))
}

/** Cancels every queued or running GitHub Actions run (recordings, trims, frames). */
export async function cancelAllGitHubRuns(env: Env): Promise<number> {
  const token = env.GITHUB_TOKEN
  if (!token) return 0
  const repo = env.GITHUB_RECORDER_REPO || 'mmody1334-gif/cb-recorder'
  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'SaveLink-Telegram-Bot',
  }
  let cancelled = 0
  for (const status of ['in_progress', 'queued', 'waiting', 'pending']) {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?status=${status}&per_page=100`, { headers })
    if (!res.ok) continue
    const data: any = await res.json()
    for (const run of data.workflow_runs || []) {
      const c = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/cancel`, {
        method: 'POST',
        headers,
      })
      if (c.ok || c.status === 202) cancelled++
    }
  }
  return cancelled
}
