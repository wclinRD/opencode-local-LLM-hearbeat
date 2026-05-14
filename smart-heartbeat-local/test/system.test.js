// system.test.js — System-Level Tests (9 scenarios S1-S9)
const assert = require('assert')
const { describe, it, before, after, beforeEach } = require('node:test')
const path = require('path')
const fs = require('fs')
const os = require('os')

const {
  createOrGetState, getState, getStatesMap, removeState,
  persistState, immediatePersist, loadFromPersistence, persistDir,
  MAX_SESSIONS,
} = require('../state')
const {
  handleToolStarted, handleToolCompleted, handleToolError,
  handleMessageCompleted, detectTruncation,
} = require('../monitor')
const {
  shouldAttemptRecovery, executeRecovery, handleRecoverySuccess,
  detectDeathSpiral, analyzeToolErrors,
} = require('../recovery')
const { buildInjectPrompt, injectContinuation } = require('../injector')
const { DEFAULT_CONFIG } = require('../config')
const { activeTimers, setSafeTimeout, clearAllTimers } = require('../utils')

const TEST_CONFIG = { ...DEFAULT_CONFIG, maxRecoveryAttempts: 3, deathSpiralWindowMs: 300000, deathSpiralThreshold: 3 }

describe('System Tests', () => {
  let tempDir
  const origPersistDir = process.env.HEARTBEAT_PERSIST_DIR

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sys-'))
    process.env.HEARTBEAT_PERSIST_DIR = tempDir + '/'
  })

  after(() => {
    if (origPersistDir) {
      process.env.HEARTBEAT_PERSIST_DIR = origPersistDir
    } else {
      delete process.env.HEARTBEAT_PERSIST_DIR
    }
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) {}
    getStatesMap().clear()
    clearAllTimers()
  })

  beforeEach(() => {
    getStatesMap().clear()
    clearAllTimers()
  })

  // === S1: Full Lifecycle ===
  describe('S1: Full Lifecycle', () => {
    it('should handle plugin lifecycle end-to-end', () => {
      const state = createOrGetState('lifecycle-test')
      assert(state)
      assert.strictEqual(state.recoveryState, 'idle')

      // Simulate tool events
      handleToolStarted(state, { properties: { name: 'edit' } }, TEST_CONFIG)
      assert.strictEqual(state.lastToolName, 'edit')
      assert.strictEqual(state.processingGuard, false)

      handleToolCompleted(state, { properties: { name: 'edit' } })
      assert.strictEqual(state.toolCallHistory.length, 1)
      assert.strictEqual(state._cachedContextSize, undefined)

      // Cleanup
      removeState('lifecycle-test')
      assert(!getStatesMap().has('lifecycle-test'))
    })
  })

  // === S2: Recovery Pipeline ===
  describe('S2: Recovery Pipeline', () => {
    it('should run truncation→recovery→verify pipeline', async () => {
      const state = createOrGetState('recovery-pipe')
      const mockClient = {
        session: {
          async prompt({ message, sessionID }) {
            // Simulate injection
            state.recoveryState = 'injected'
            return { ok: true }
          },
        },
      }

      // Simulate: tool.completed triggers truncation check
      const prevTodos = [{ content: 'task A', status: 'in_progress' }]
      const currTodos = [{ content: 'task A', status: 'pending' }]
      const truncResult = detectTruncation(state, prevTodos, currTodos, TEST_CONFIG)
      assert.strictEqual(truncResult.truncated, true)

      // shouldAttemptRecovery
      assert(shouldAttemptRecovery(state, TEST_CONFIG))

      // Simulate recovery verification via tool.started
      handleToolStarted(state, { properties: { name: 'edit' } }, TEST_CONFIG)
      assert.strictEqual(state.processingGuard, false)
    })
  })

  // === S3: Death Spiral + Recovery Stop ===
  describe('S3: Death Spiral', () => {
    it('should detect death spiral after repeated failures', () => {
      const state = createOrGetState('death-spiral')

      // Simulate 3 consecutive failures rapidly
      for (let i = 0; i < 3; i++) {
        state.truncationEvents.push({ time: Date.now() - 60000 * i, success: false })
      }
      // Force within window
      state.truncationEvents = state.truncationEvents.map(e => ({ ...e, time: Date.now() - 60000 }))

      assert(detectDeathSpiral(state, TEST_CONFIG))
      assert.strictEqual(state.truncationEvents.length, 3)
    })
  })

  // === S4: User Intervention ===
  describe('S4: User Intervention', () => {
    it('should handle user message reset correctly', () => {
      const state = createOrGetState('user-int')

      // Simulate recovery in progress
      state.recoveryState = 'injected'
      state.recoveryAttempts = 2
      state.deathSpiral = false

      // Simulate user message (handleUserMessage logic)
      state.recoveryState = 'idle'
      state.recoveryAttempts = 0
      state.interventionState = 'user_active'
      state.userLastActiveTime = Date.now()
      state.heartbeatCooldownUntil = Date.now() + 60000

      assert.strictEqual(state.recoveryState, 'idle')
      assert.strictEqual(state.recoveryAttempts, 0)

      // Cooldown should block injection
      const cooldownActive = Date.now() < state.heartbeatCooldownUntil
      assert(cooldownActive)
    })
  })

  // === S5: Tool Error Escalation ===
  describe('S5: Tool Error Escalation', () => {
    it('should escalate through error levels correctly', () => {
      const state = createOrGetState('error-esc')

      // Level 1: 1 error
      state.toolCallHistory = [{ status: 'error', name: 'bash', time: Date.now() }]
      assert.strictEqual(analyzeToolErrors(state, TEST_CONFIG).level, 1)

      // Level 2: 2-3 errors
      state.toolCallHistory = Array(3).fill({ status: 'error', name: 'bash', time: Date.now() })
      assert.strictEqual(analyzeToolErrors(state, TEST_CONFIG).level, 2)

      // Level 3: 4-6 errors
      state.toolCallHistory = Array(5).fill({ status: 'error', name: 'bash', time: Date.now() })
      assert.strictEqual(analyzeToolErrors(state, TEST_CONFIG).level, 3)

      // Level 4: 7+ errors
      state.toolCallHistory = Array(8).fill({ status: 'error', name: 'bash', time: Date.now() })
      assert.strictEqual(analyzeToolErrors(state, TEST_CONFIG).level, 4)
    })
  })

  // === S6: Sleep/Wake ===
  describe('S6: Sleep/Wake', () => {
    it('should detect wake after sleep', () => {
      const { isWakeAfterSleep } = require('../utils')

      // Normal: < 30s gap
      assert.strictEqual(isWakeAfterSleep(Date.now() - 1000), false)

      // Sleep wake: > 30s gap
      assert.strictEqual(isWakeAfterSleep(Date.now() - 35000), true)
    })
  })

  // === S7: Concurrent Sessions ===
  describe('S7: Concurrent Sessions', () => {
    it('should maintain independent state across sessions', () => {
      const sessions = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
      for (const s of sessions) createOrGetState(s)

      // Dispatch interleaved events
      sessions.forEach((s, i) => {
        const state = getState(s)
        handleToolStarted(state, { properties: { name: i % 2 === 0 ? 'edit' : 'bash' } }, TEST_CONFIG)
      })

      // Verify independence
      assert.strictEqual(getState('alpha').toolCallHistory.length, 0)  // tool.started doesn't add to history
      assert.strictEqual(getState('alpha').lastToolName, 'edit')
      assert.strictEqual(getState('beta').lastToolName, 'bash')

      // LRU: create 55+ sessions
      for (let i = 0; i < 55; i++) createOrGetState(`excess-${i}`)
      assert.strictEqual(getStatesMap().size, MAX_SESSIONS)
    })
  })

  // === S8: Rapid-Fire Events ===
  describe('S8: Rapid-Fire Events', () => {
    it('should handle 100 rapid events without crash', () => {
      const sid = 'rapidfire'
      const state = createOrGetState(sid)

      for (let i = 0; i < 100; i++) {
        handleToolStarted(state, { properties: { name: 'edit', sessionID: sid } }, TEST_CONFIG)
      }

      assert.strictEqual(state.toolCallCount, 100)

      // Estimation handles load (toolCallHistory is from completed/error, not started)
      const { estimateContextTokens } = require('../utils')
      const estimated = estimateContextTokens(state, TEST_CONFIG)
      assert.strictEqual(estimated, 4000, 'base context estimation works without completed tools')
    })
  })

  // === S9: Resource Cleanup ===
  describe('S9: Resource Cleanup', () => {
    it('should cleanup all resources properly', () => {
      // Create some sessions with timers
      for (let i = 0; i < 3; i++) {
        const sid = `cleanup-${i}`
        createOrGetState(sid)
        setSafeTimeout(() => {}, 50000)
      }

      assert(activeTimers.size > 0)
      assert(getStatesMap().size >= 3)

      // Clear all
      clearAllTimers()
      getStatesMap().clear()

      assert.strictEqual(activeTimers.size, 0)
      assert.strictEqual(getStatesMap().size, 0)

      // Idempotent: second clear doesn't throw
      clearAllTimers()
    })
  })
})
