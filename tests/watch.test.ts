import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  parseWatchTarget,
  addWatchTarget,
  removeWatchTarget,
  listUserWatchTargets,
  watchLockKey,
  watchUnknownStreakKey,
  clearWatchLock,
  clearAllWatchLocksForTarget,
  checkTargetLive,
  triggerWatchTargetIfLive,
  runWatchCycle,
  WATCH_CHECK_INTERVAL_MINUTES,
  WATCH_UNKNOWN_STREAK_TO_DISPATCH,
} from '../src/watch'
import { getStore } from '../src/store'

describe('Watch & Auto-record', () => {
  let store: any

  beforeEach(async () => {
    store = getStore({})
    await store.delete('watch:index:all')
    await store.delete('watch:user:12345')
    await store.delete('watch:user:999')
    await clearAllWatchLocksForTarget(store, 'pamy_assam')
    await clearAllWatchLocksForTarget(store, 'shad.208')
    await clearAllWatchLocksForTarget(store, 'modelx')
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

  it('manages watch lock keys and clears locks properly', async () => {
    expect(watchLockKey('Chaturbate', 'pamy_assam')).toBe('watch:lock:chaturbate:pamy_assam')
    expect(watchLockKey('tiktok', '@shad.208')).toBe('watch:lock:tiktok:shad.208')

    // Set locks
    await store.put(watchLockKey('chaturbate', 'pamy_assam'), '12345678')
    expect(await store.get(watchLockKey('chaturbate', 'pamy_assam'))).toBe('12345678')

    // Clear single lock
    await clearWatchLock(store, 'chaturbate', 'pamy_assam')
    expect(await store.get(watchLockKey('chaturbate', 'pamy_assam'))).toBeNull()

    // Clear all locks for target
    await store.put('watch:lock:chaturbate:modelx', '111')
    await store.put('watch:lock:stripchat:modelx', '222')
    await store.put('watch:lock:tiktok:modelx', '333')
    await clearAllWatchLocksForTarget(store, 'modelx')
    expect(await store.get('watch:lock:chaturbate:modelx')).toBeNull()
    expect(await store.get('watch:lock:stripchat:modelx')).toBeNull()
    expect(await store.get('watch:lock:tiktok:modelx')).toBeNull()
  })

  it('clears lock on removeWatchTarget', async () => {
    await addWatchTarget(12345, 'pamy_assam', store)
    const lock = watchLockKey('chaturbate', 'pamy_assam')
    await store.put(lock, 'active_session')
    expect(await store.get(lock)).toBe('active_session')

    await removeWatchTarget(12345, 'pamy_assam', store)
    expect(await store.get(lock)).toBeNull()
  })

  it('runWatchCycle auto-clears lock when model transitions to offline', async () => {
    // Mock global fetch to simulate model being offline
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('chatvideocontext')) {
        return new Response(JSON.stringify({ room_status: 'offline' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('Not Found', { status: 404 })
    })

    try {
      await addWatchTarget(12345, 'pamy_assam', store)
      const lock = watchLockKey('chaturbate', 'pamy_assam')
      await store.put(lock, 'stale_session_lock')
      expect(await store.get(lock)).toBe('stale_session_lock')

      const env: any = { GITHUB_TOKEN: 'fake_token' }
      const res = await runWatchCycle(env, store)
      expect(res.checked).toBe(1)
      expect(res.triggered).toBe(0)

      // The lock MUST be auto-cleared because she is offline!
      expect(await store.get(lock)).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('checkTargetLive resolves Chaturbate via primary and fallback endpoints', async () => {
    const originalFetch = globalThis.fetch

    // Case 1: Primary chatvideocontext succeeds with public live room
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('chatvideocontext')) {
        return new Response(JSON.stringify({ room_status: 'public', hls_source: 'https://example.com/live.m3u8', num_viewers: 500 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('Not Found', { status: 404 })
    })

    const target: any = { platform: 'chaturbate', identifier: 'pamy_assam', target: 'pamy_assam', chatId: 123 }
    const res1 = await checkTargetLive(target)
    expect(res1.state).toBe('live')
    expect(res1.recordable).toBe(true)
    expect(res1.viewers).toBe(500)

    // Case 2: Primary fails (e.g. 500 or blocked), Fallback get_edge_hls_url_ajax succeeds
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('chatvideocontext')) {
        return new Response('Error', { status: 500 })
      }
      if (url.includes('get_edge_hls_url_ajax')) {
        return new Response(JSON.stringify({ room_status: 'public', url: 'https://edge.example.com/playlist.m3u8' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('Not Found', { status: 404 })
    })

    const res2 = await checkTargetLive(target)
    expect(res2.state).toBe('live')
    expect(res2.recordable).toBe(true)
    expect(res2.hls).toBe('https://edge.example.com/playlist.m3u8')

    globalThis.fetch = originalFetch
  })

  it('triggerWatchTargetIfLive triggers recorder and locks target', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('chatvideocontext')) {
        return new Response(JSON.stringify({ room_status: 'public', hls_source: 'https://example.com/live.m3u8' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('api.github.com')) {
        return new Response(null, { status: 204 })
      }
      return new Response('Not Found', { status: 404 })
    })

    try {
      const target: any = { platform: 'chaturbate', identifier: 'pamy_assam', target: 'pamy_assam', chatId: 123 }
      const env: any = { GITHUB_TOKEN: 'fake_token', BOT_TOKEN: 'fake_bot' }

      const firstTrigger = await triggerWatchTargetIfLive(env, store, target)
      expect(firstTrigger.live).toBe(true)
      expect(firstTrigger.triggered).toBe(true)

      // Subsequent trigger immediately sees already_recording
      const secondTrigger = await triggerWatchTargetIfLive(env, store, target)
      expect(secondTrigger.live).toBe(true)
      expect(secondTrigger.triggered).toBe(false)
      expect(secondTrigger.detail).toBe('already_recording')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('check interval is a single source of truth matching the 2-minute cron', () => {
    expect(WATCH_CHECK_INTERVAL_MINUTES).toBe(2)
    expect(WATCH_UNKNOWN_STREAK_TO_DISPATCH).toBe(3)
  })

  it('triggerWatchTargetIfLive does not dispatch a runner for an offline target', async () => {
    const originalFetch = globalThis.fetch
    let githubCalls = 0
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('chatvideocontext')) {
        return new Response(JSON.stringify({ room_status: 'offline' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('api.github.com')) {
        githubCalls += 1
        return new Response(null, { status: 204 })
      }
      return new Response('Not Found', { status: 404 })
    })

    try {
      const target: any = { platform: 'chaturbate', identifier: 'offline_model', target: 'offline_model', chatId: 123 }
      const env: any = { GITHUB_TOKEN: 'fake_token', BOT_TOKEN: 'fake_bot' }
      const res = await triggerWatchTargetIfLive(env, store, target)
      expect(res.live).toBe(false)
      expect(res.triggered).toBe(false)
      expect(res.detail).toBe('offline')
      expect(githubCalls).toBe(0)
      expect(await store.get(watchLockKey('chaturbate', 'offline_model'))).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('triggerWatchTargetIfLive still dispatches a cloud watcher when the check is unknown', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('chatvideocontext') || url.includes('get_edge_hls_url_ajax')) {
        return new Response('Forbidden', { status: 403 })
      }
      if (url.includes('api.github.com')) {
        return new Response(null, { status: 204 })
      }
      return new Response('Not Found', { status: 404 })
    })

    try {
      const target: any = { platform: 'chaturbate', identifier: 'blocked_model', target: 'blocked_model', chatId: 123 }
      const env: any = { GITHUB_TOKEN: 'fake_token', BOT_TOKEN: 'fake_bot' }
      const res = await triggerWatchTargetIfLive(env, store, target)
      expect(res.live).toBe(false)
      expect(res.triggered).toBe(true)
      expect(await store.get(watchLockKey('chaturbate', 'blocked_model'))).toBeTruthy()
    } finally {
      globalThis.fetch = originalFetch
      await clearWatchLock(store, 'chaturbate', 'blocked_model')
    }
  })

  it('runWatchCycle dispatches a cloud watcher only after a persistent unknown streak', async () => {
    const originalFetch = globalThis.fetch
    let githubCalls = 0
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('chatvideocontext') || url.includes('get_edge_hls_url_ajax')) {
        return new Response('Forbidden', { status: 403 })
      }
      if (url.includes('api.github.com')) {
        githubCalls += 1
        return new Response(null, { status: 204 })
      }
      return new Response('Not Found', { status: 404 })
    })

    try {
      await addWatchTarget(777, 'streak_model', store)
      const env: any = { GITHUB_TOKEN: 'fake_token', BOT_TOKEN: 'fake_bot' }

      const cycle1 = await runWatchCycle(env, store)
      expect(cycle1.checked).toBe(1)
      expect(cycle1.triggered).toBe(0)
      expect(cycle1.unknown).toBe(1)
      expect(githubCalls).toBe(0)

      const cycle2 = await runWatchCycle(env, store)
      expect(cycle2.triggered).toBe(0)
      expect(githubCalls).toBe(0)

      // Third consecutive unknown cycle: the streak threshold is reached.
      const cycle3 = await runWatchCycle(env, store)
      expect(cycle3.triggered).toBe(1)
      expect(githubCalls).toBe(1)

      // Fourth cycle: the session lock caps it — no second runner.
      const cycle4 = await runWatchCycle(env, store)
      expect(cycle4.triggered).toBe(0)
      expect(githubCalls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      await removeWatchTarget(777, 'streak_model', store)
      await store.delete(watchUnknownStreakKey('chaturbate', 'streak_model'))
    }
  })

  it('runWatchCycle never dispatches for a TikTok name that does not exist (http_404)', async () => {
    const originalFetch = globalThis.fetch
    let githubCalls = 0
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('api.github.com')) {
        githubCalls += 1
        return new Response(null, { status: 204 })
      }
      return new Response('Not Found', { status: 404 })
    })

    try {
      await addWatchTarget(778, '@nosuchuser', store)
      const env: any = { GITHUB_TOKEN: 'fake_token', BOT_TOKEN: 'fake_bot' }
      for (let i = 0; i < 3; i += 1) {
        const cycle = await runWatchCycle(env, store)
        expect(cycle.triggered).toBe(0)
        expect(cycle.unknown).toBe(1)
      }
      expect(githubCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
      await removeWatchTarget(778, '@nosuchuser', store)
      await store.delete(watchUnknownStreakKey('tiktok', 'nosuchuser'))
    }
  })

  it('full watch cycle state machine: live -> locked -> offline auto-release -> re-live triggered', async () => {
    let mockLive = true
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('chatvideocontext')) {
        return new Response(
          JSON.stringify({
            room_status: mockLive ? 'public' : 'offline',
            hls_source: mockLive ? 'https://example.com/hls.m3u8' : '',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('api.github.com')) {
        return new Response(null, { status: 204 })
      }
      return new Response('Not Found', { status: 404 })
    })

    try {
      await addWatchTarget(999, 'pamy_assam', store)
      const lockKey = watchLockKey('chaturbate', 'pamy_assam')
      const env: any = { GITHUB_TOKEN: 'fake_token', BOT_TOKEN: 'fake_bot' }

      // 1. First cycle: Model is live -> Dispatches recorder and sets lock!
      mockLive = true
      const cycle1 = await runWatchCycle(env, store)
      expect(cycle1.checked).toBe(1)
      expect(cycle1.triggered).toBe(1)
      expect(await store.get(lockKey)).toBeTruthy()

      // 2. Second cycle: Model is still live -> Lock exists, skips duplicate trigger!
      const cycle2 = await runWatchCycle(env, store)
      expect(cycle2.checked).toBe(1)
      expect(cycle2.triggered).toBe(0)
      expect(await store.get(lockKey)).toBeTruthy()

      // 3. Third cycle: Model goes offline -> Lock is auto-cleared!
      mockLive = false
      const cycle3 = await runWatchCycle(env, store)
      expect(cycle3.checked).toBe(1)
      expect(cycle3.triggered).toBe(0)
      expect(await store.get(lockKey)).toBeNull() // Cleared!

      // 4. Fourth cycle: Model comes back live -> Lock is absent, NEW recording triggered!
      mockLive = true
      const cycle4 = await runWatchCycle(env, store)
      expect(cycle4.checked).toBe(1)
      expect(cycle4.triggered).toBe(1) // Triggered again!
      expect(await store.get(lockKey)).toBeTruthy()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
