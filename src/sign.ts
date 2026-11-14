const encoder = new TextEncoder()
const decoder = new TextDecoder()

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.length % 4 === 0 ? value : value + '='.repeat(4 - (value.length % 4))
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

export async function signToken(payload: Record<string, unknown>, secret: string, ttlSeconds = 3600): Promise<string> {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }
  const data = encoder.encode(JSON.stringify(body))
  const signature = await crypto.subtle.sign('HMAC', await importKey(secret), data)
  return `${base64url(data)}.${base64url(new Uint8Array(signature))}`
}

export async function verifyToken<T extends { exp?: number }>(token: string, secret: string): Promise<T | null> {
  const [bodyPart, signaturePart] = token.split('.')
  if (!bodyPart || !signaturePart) return null
  let data: Uint8Array
  let signature: Uint8Array
  try {
    data = fromBase64url(bodyPart)
    signature = fromBase64url(signaturePart)
  } catch {
    return null
  }
  const valid = await crypto.subtle.verify(
    'HMAC',
    await importKey(secret),
    signature as unknown as BufferSource,
    data as unknown as BufferSource,
  )
  if (!valid) return null
  try {
    const parsed = JSON.parse(decoder.decode(data)) as T
    if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) return null
    return parsed
  } catch {
    return null
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
