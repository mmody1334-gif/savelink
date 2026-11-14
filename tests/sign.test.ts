import { describe, expect, it } from 'vitest'
import { signToken, verifyToken } from '../src/sign'

const SECRET = 'unit-test-secret'

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('signToken / verifyToken', () => {
  it('round-trips a payload', async () => {
    const token = await signToken({ hello: 'world' }, SECRET, 60)
    const parsed = await verifyToken<{ hello: string; exp: number }>(token, SECRET)
    expect(parsed?.hello).toBe('world')
    expect(parsed?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('rejects a tampered payload', async () => {
    const token = await signToken({ admin: false }, SECRET, 60)
    const [body, signature] = token.split('.')
    const forged = `${toBase64Url(JSON.stringify({ admin: true, exp: 9999999999 }))}.${signature}`
    expect(await verifyToken(forged, SECRET)).toBeNull()
    expect(body.length).toBeGreaterThan(0)
  })

  it('rejects a tampered signature', async () => {
    const token = await signToken({ hello: 'world' }, SECRET, 60)
    const [body, signature] = token.split('.')
    const forged = `${body}.${signature.slice(0, -2)}xx`
    expect(await verifyToken(forged, SECRET)).toBeNull()
  })

  it('rejects a different secret', async () => {
    const token = await signToken({ hello: 'world' }, SECRET, 60)
    expect(await verifyToken(token, 'another-secret')).toBeNull()
  })

  it('rejects expired tokens', async () => {
    const token = await signToken({ hello: 'world' }, SECRET, -1)
    expect(await verifyToken(token, SECRET)).toBeNull()
  })

  it('rejects malformed tokens', async () => {
    expect(await verifyToken('nope', SECRET)).toBeNull()
    expect(await verifyToken('a.b.c', SECRET)).toBeNull()
  })
})
