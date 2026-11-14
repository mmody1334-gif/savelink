import { publicBase } from './config'
import { signToken, verifyToken } from './sign'
import type { Env, MediaItem } from './types'

export interface FileToken {
  /** upstream url */
  u: string
  /** download filename */
  n?: string
  /** mime type */
  m?: string
  /** size in bytes */
  s?: number
  /** referer required by some CDNs */
  r?: string
  exp: number
}

const DEV_SECRET = 'savelink-dev-signing-secret-change-me'
let warned = false

function signingSecret(env: Env): string {
  if (env.SIGNING_SECRET) return env.SIGNING_SECRET
  if (!warned) {
    warned = true
    console.warn('SIGNING_SECRET is not set, using an insecure development secret')
  }
  return DEV_SECRET
}

export async function signFileUrl(
  item: MediaItem,
  filename: string,
  env: Env,
  requestOrigin: string,
  ttlSeconds = 86400,
): Promise<string> {
  const token = await signToken(
    { u: item.url, n: filename, m: item.mime, s: item.size, r: item.referer },
    signingSecret(env),
    ttlSeconds,
  )
  return `${publicBase(env, requestOrigin)}/api/file?t=${token}`
}

export async function verifyFileToken(token: string, env: Env): Promise<FileToken | null> {
  return await verifyToken<FileToken>(token, signingSecret(env))
}

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '')
  return `attachment; filename="${ascii || 'download'}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
