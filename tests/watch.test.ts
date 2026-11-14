import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseWatchTarget,
  addWatchTarget,
  removeWatchTarget,
  listUserWatchTargets,
} from '../src/watch'
import { getStore } from '../src/store'

describe('Watch & Auto-record', () => {
  let store: any

  beforeEach(() => {
    store = getStore({})
  })

  it('parses TikTok target correctly', () => {
    const res1 = parseWatchTarget('@shad.208')
    expect(res1).toEqual({ platform: 'tiktok', identifier: 'shad.208', clean: '@shad.208' })

    const res2 = parseWatchTarget('https://www.tiktok.com/@shad.208/live')
    expect(res2).toEqual({ platform: 'tiktok', identifier: 'shad.208', clean: '@shad.208' })
  })

  it('parses Chaturbate target correctly', () => {
    const res1 = parseWatchTarget('visceratio')
    expect(res1).toEqual({ platform: 'chaturbate', identifier: 'visceratio', clean: 'visceratio' })

    const res2 = parseWatchTarget('https://chaturbate.com/visceratio')
    expect(res2).toEqual({ platform: 'chaturbate', identifier: 'visceratio', clean: 'visceratio' })
  })

  it('parses Stripchat target correctly', () => {
    const res1 = parseWatchTarget('https://stripchat.com/TUNDEROSE1')
    expect(res1).toEqual({ platform: 'stripchat', identifier: 'tunderose1', clean: 'https://stripchat.com/tunderose1' })

    const res2 = parseWatchTarget('stripchat_TUNDEROSE1')
    expect(res2).toEqual({ platform: 'stripchat', identifier: 'tunderose1', clean: 'https://stripchat.com/tunderose1' })
  })

  it('adds, lists and removes watch targets', async () => {
    const addRes = await addWatchTarget(12345, '@shad.208', store)
    expect(addRes.ok).toBe(true)
    expect(addRes.target?.target).toBe('@shad.208')

    // Duplicate prevention
    const dupRes = await addWatchTarget(12345, '@shad.208', store)
    expect(dupRes.ok).toBe(false)
    expect(dupRes.error).toBe('already_watched')

    // List targets
    const list = await listUserWatchTargets(12345, store)
    expect(list.length).toBe(1)
    expect(list[0].identifier).toBe('shad.208')

    // Remove target
    const remRes = await removeWatchTarget(12345, '@shad.208', store)
    expect(remRes.ok).toBe(true)
    expect(remRes.count).toBe(1)

    const listAfter = await listUserWatchTargets(12345, store)
    expect(listAfter.length).toBe(0)
  })
})
