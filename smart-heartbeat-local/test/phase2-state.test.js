// phase2-state.test.js — State Unit Tests (12 cases)
const assert = require('assert')
const { describe, it, before, after, beforeEach } = require('node:test')
const path = require('path')
const fs = require('fs')
const os = require('os')
const {
  createOrGetState,
  getState,
  getStatesMap,
  removeState,
  persistState,
  immediatePersist,
  loadFromPersistence,
  loadAllFromPersistence,
  buildPersistData,
  inflateStateFromPersist,
  cleanStaleFiles,
  clearPersistenceDebounce,
  persistDir,
  MAX_SESSIONS,
} = require('../state')
const { handleMessageCompleted } = require('../monitor')

describe('state.js', () => {
  let tempDir
  const originalPersistDir = process.env.HEARTBEAT_PERSIST_DIR

  before(() => {
    // Override persistDir for tests via env var
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-test-'))
    process.env.HEARTBEAT_PERSIST_DIR = tempDir + '/'
  })

  after(() => {
    // Restore original env
    if (originalPersistDir) {
      process.env.HEARTBEAT_PERSIST_DIR = originalPersistDir
    } else {
      delete process.env.HEARTBEAT_PERSIST_DIR
    }
    // Cleanup temp dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch (_) {}
    // Clear states
    const map = getStatesMap()
    map.clear()
  })

  beforeEach(() => {
    const map = getStatesMap()
    map.clear()
  })

  // === createOrGetState (2 cases) ===
  describe('createOrGetState', () => {
    it('should create new session state', () => {
      const state = createOrGetState('test-ses')
      assert(state)
      assert.strictEqual(state.recoveryState, 'idle')
      assert.strictEqual(state.toolErrorCount, 0)
      assert.strictEqual(state.sessionIDSafe, 'test-ses')
    })

    it('should return existing state for same session', () => {
      const s1 = createOrGetState('test-ses')
      const s2 = createOrGetState('test-ses')
      assert.strictEqual(s1, s2)
    })
  })

  // === LRU eviction (2 cases) ===
  describe('LRU eviction', () => {
    it('should evict oldest when exceeding MAX_SESSIONS', () => {
      for (let i = 0; i < MAX_SESSIONS + 2; i++) {
        createOrGetState(`ses_${i}`)
      }
      const map = getStatesMap()
      assert(map.has(`ses_${MAX_SESSIONS + 1}`))  // newest exists
      assert(!map.has('ses_0'))                     // oldest evicted
      assert(!map.has('ses_1'))                     // second oldest evicted
      assert.strictEqual(map.size, MAX_SESSIONS)
    })

    it('should allow new sessions after eviction', () => {
      for (let i = 0; i < MAX_SESSIONS + 5; i++) {
        createOrGetState(`evict_${i}`)
      }
      const state = createOrGetState('fresh-session')
      assert(state)
      assert.strictEqual(getStatesMap().size, MAX_SESSIONS)
    })
  })

  // === removeState (1 case) ===
  describe('removeState', () => {
    it('should remove session from map', () => {
      createOrGetState('remove-me')
      assert(getStatesMap().has('remove-me'))
      removeState('remove-me')
      assert(!getStatesMap().has('remove-me'))
    })
  })

  // === exchangeCount via handleMessageCompleted (2 cases) ===
  describe('exchangeCount', () => {
    it('should increment exchangeCount on user message', () => {
      const state = createOrGetState('exch-test')
      handleMessageCompleted(state, { info: { role: 'user' } })
      assert.strictEqual(state.exchangeCount, 1)
    })

    it('should NOT increment on non-user message', () => {
      const state = createOrGetState('exch-test2')
      handleMessageCompleted(state, { info: { role: 'assistant' } })
      assert.strictEqual(state.exchangeCount, 0)
    })
  })

  // === Persistence round-trip (2 cases) ===
  describe('persistence', () => {
    it('should persist and load state correctly', async () => {
      const state = createOrGetState('persist-test')
      state.deathSpiral = true
      state.recoveryState = 'stopped'
      state.recoveryAttempts = 3
      state.truncationEvents = [
        { time: 100, success: false },
        { time: 200, success: false },
      ]

      await immediatePersist('persist-test', state)

      const loadedState = await loadFromPersistence('persist-test')
      assert(loadedState !== null)
      assert.strictEqual(loadedState.deathSpiral, true)
      assert.strictEqual(loadedState.recoveryState, 'stopped')
      assert.strictEqual(loadedState.recoveryAttempts, 3)
      assert.strictEqual(loadedState.truncationEvents.length, 2)
    })

    it('should return null for non-existent session', async () => {
      const result = await loadFromPersistence('nonexistent')
      assert.strictEqual(result, null)
    })
  })

  // === Stale file cleanup (1 case) ===
  describe('cleanStaleFiles', () => {
    it('should clean stale files', async () => {
      // Create stale file (modify mtime directly)
      const stalePath = path.join(tempDir, 'stale-test.json')
      await fs.promises.writeFile(stalePath, JSON.stringify({ sessionID: 'stale-test', version: 2 }))
      const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000)
      await fs.promises.utimes(stalePath, oldTime, oldTime)

      // Create fresh file
      const freshPath = path.join(tempDir, 'fresh-test.json')
      await fs.promises.writeFile(freshPath, JSON.stringify({ sessionID: 'fresh-test', version: 2 }))

      await cleanStaleFiles()

      // Stale file should be gone, fresh file remains
      const files = await fs.promises.readdir(tempDir)
      assert(!files.includes('stale-test.json'), 'stale file should be deleted')
      assert(files.includes('fresh-test.json'), 'fresh file should remain')
    })
  })

  // === buildPersistData (implicit) ===
  describe('buildPersistData', () => {
    it('should include version 2 fields', () => {
      const state = createOrGetState('build-test')
      state.deathSpiral = true
      state.recoveryState = 'injected'
      const data = buildPersistData('build-test', state)
      assert.strictEqual(data.version, 2)
      assert.strictEqual(data.deathSpiral, true)
      assert.strictEqual(data.recoveryState, 'injected')
    })
  })
})
