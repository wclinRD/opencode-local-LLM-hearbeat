// phase3-recovery.test.js — Recovery Unit Tests (27 cases)
const assert = require('assert')
const { describe, it, beforeEach } = require('node:test')
const {
  shouldAttemptRecovery,
  executeRecovery,
  handleRecoverySuccess,
  handleRecoveryFailure,
  detectDeathSpiral,
  assessRecoveryQuality,
  analyzeToolErrors,
  buildToolEscalationPrompt,
  getRecoveryPrompt,
} = require('../recovery')
const { createOrGetState, getStatesMap } = require('../state')
const { DEFAULT_CONFIG } = require('../config')

const TEST_CONFIG = { ...DEFAULT_CONFIG, maxRecoveryAttempts: 3, deathSpiralWindowMs: 300000, deathSpiralThreshold: 3 }

describe('recovery.js', () => {
  beforeEach(() => {
    getStatesMap().clear()
  })

  // === shouldAttemptRecovery (7 blocking conditions + 1 pass) ===
  describe('shouldAttemptRecovery', () => {
    it('should block when recoveryState is not idle', () => {
      const state = createOrGetState('test')
      state.recoveryState = 'injected'
      assert.strictEqual(shouldAttemptRecovery(state, TEST_CONFIG), false)
      state.recoveryState = 'verified'
      assert.strictEqual(shouldAttemptRecovery(state, TEST_CONFIG), false)
    })

    it('should block when deathSpiral is true', () => {
      const state = createOrGetState('test')
      state.deathSpiral = true
      assert.strictEqual(shouldAttemptRecovery(state, TEST_CONFIG), false)
    })

    it('should block when max attempts reached', () => {
      const state = createOrGetState('test')
      state.recoveryAttempts = TEST_CONFIG.maxRecoveryAttempts + 1
      assert.strictEqual(shouldAttemptRecovery(state, TEST_CONFIG), false)
    })

    it('should block when contextWarnings >= 3', () => {
      const state = createOrGetState('test')
      state.contextWarnings = 3
      assert.strictEqual(shouldAttemptRecovery(state, TEST_CONFIG), false)
    })

    it('should block when processingGuard is true', () => {
      const state = createOrGetState('test')
      state.processingGuard = true
      assert.strictEqual(shouldAttemptRecovery(state, TEST_CONFIG), false)
    })

    it('should block when waitingForTool is true', () => {
      const state = createOrGetState('test')
      state.waitingForTool = true
      assert.strictEqual(shouldAttemptRecovery(state, TEST_CONFIG), false)
    })

    it('should pass when all conditions clear', () => {
      const state = createOrGetState('test')
      assert.strictEqual(shouldAttemptRecovery(state, TEST_CONFIG), true)
    })
  })

  // === detectDeathSpiral (5 methods) ===
  describe('detectDeathSpiral', () => {
    it('Method 1: frequency — 3+ truncation events in window', () => {
      const state = createOrGetState('test')
      state.truncationEvents = Array(3).fill({ time: Date.now() - 60000, success: false })
      assert(detectDeathSpiral(state, TEST_CONFIG))
    })

    it('Method 2: consecutive failures — 2+ failed recoveries', () => {
      const state = createOrGetState('test')
      state.truncationEvents = [
        { time: Date.now() - 120000, success: false },
        { time: Date.now() - 60000, success: false },
      ]
      assert(detectDeathSpiral(state, TEST_CONFIG))
    })

    it('Method 3: contextPressure + truncation', () => {
      const state = createOrGetState('test')
      state.contextWarnings = 5
      state.truncationEvents = [{ time: Date.now() - 120000, success: true }]
      assert(detectDeathSpiral(state, TEST_CONFIG))
    })

    it('Method 4: toolErrorSpiral', () => {
      const state = createOrGetState('test')
      state.truncationEvents = [{ time: Date.now() - 90000, success: false }]
      state.toolErrorAnalysis = { level: 3, pattern: 'single_tool', toolType: 'bash', errorCount: 4, consecutiveSameTool: false, lastErrorTool: 'bash' }
      state.contextWarnings = 0
      assert(detectDeathSpiral(state, TEST_CONFIG))
    })

    it('Method 5: sameToolCascade', () => {
      const state = createOrGetState('test')
      state.toolErrorAnalysis = { level: 4, pattern: 'single_tool', toolType: 'edit', errorCount: 6, consecutiveSameTool: true, lastErrorTool: 'edit' }
      state.truncationEvents = []
      assert(detectDeathSpiral(state, TEST_CONFIG))
    })
  })

  // === getRecoveryPrompt (4 cases) ===
  describe('getRecoveryPrompt', () => {
    it('Level 0 should return 繼續', () => {
      assert.strictEqual(getRecoveryPrompt(0, [], null, null), '繼續')
    })

    it('Level 1 should return 繼續任務', () => {
      assert.strictEqual(getRecoveryPrompt(1, [], null, null), '繼續任務')
    })

    it('Level 2 should include task name', () => {
      const todos = [{ content: 'test task', status: 'in_progress' }]
      const result = getRecoveryPrompt(2, todos, null, null)
      assert(result.includes('test task'))
    })

    it('Level 3 should return full recovery prompt', () => {
      const todos = [
        { content: 'task A', status: 'in_progress' },
        { content: 'task B', status: 'pending' },
      ]
      const result = getRecoveryPrompt(3, todos, null, null)
      assert(result.includes('task A'))
      assert(result.includes('task B'))
      assert(result.includes('上下文已重置'))
    })
  })

  // === assessRecoveryQuality (1 case) ===
  describe('assessRecoveryQuality', () => {
    it('should assess confused vs good quality', () => {
      const state = createOrGetState('test')
      state.lastToolBeforeTruncation = 'edit'

      // Same tool → confused
      assessRecoveryQuality(state, { properties: { name: 'edit' } })
      assert.strictEqual(state.recoveryQuality, 'confused')

      // Different tool → good
      assessRecoveryQuality(state, { properties: { name: 'bash' } })
      assert.strictEqual(state.recoveryQuality, 'good')
    })
  })

  // === analyzeToolErrors (4 levels) ===
  describe('analyzeToolErrors', () => {
    it('should return level 0 for no errors', () => {
      const state = createOrGetState('test')
      const result = analyzeToolErrors(state, TEST_CONFIG)
      assert.strictEqual(result.level, 0)
    })

    it('should return level 1 for 1 error', () => {
      const state = createOrGetState('test')
      state.toolCallHistory = [{ status: 'error', name: 'bash' }]
      assert.strictEqual(analyzeToolErrors(state, TEST_CONFIG).level, 1)
    })

    it('should return level 2 for 2-3 errors', () => {
      const state = createOrGetState('test')
      state.toolCallHistory = [
        { status: 'error', name: 'bash' },
        { status: 'error', name: 'bash' },
      ]
      assert.strictEqual(analyzeToolErrors(state, TEST_CONFIG).level, 2)
    })

    it('should return level 3 for 4-6 errors', () => {
      const state = createOrGetState('test')
      state.toolCallHistory = Array(4).fill({ status: 'error', name: 'bash' })
      assert.strictEqual(analyzeToolErrors(state, TEST_CONFIG).level, 3)
    })

    it('should return level 4 for 7+ errors', () => {
      const state = createOrGetState('test')
      state.toolCallHistory = Array(7).fill({ status: 'error', name: 'bash' })
      assert.strictEqual(analyzeToolErrors(state, TEST_CONFIG).level, 4)
    })
  })

  // === buildToolEscalationPrompt ===
  describe('buildToolEscalationPrompt', () => {
    it('should return tool-type specific prompts', () => {
      const analysis = { level: 3, toolType: 'bash', errorCount: 5 }
      const result = buildToolEscalationPrompt(analysis, 'my task')
      assert(result.includes('bash'))
      assert(result.includes('5'))
    })

    it('should return web search prompt for level 4', () => {
      const analysis = { level: 4, errorCount: 8 }
      const result = buildToolEscalationPrompt(analysis, 'my task')
      assert(result.includes('websearch'))
    })
  })
})
