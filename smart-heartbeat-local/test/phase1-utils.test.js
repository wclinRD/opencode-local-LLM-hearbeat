// phase1-utils.test.js — Phase 1 Utils Unit Tests (11 cases)
const assert = require('assert')
const { describe, it } = require('node:test')
const {
  sanitizeSessionID,
  estimateContextTokens,
  estimateProcessTime,
  isWakeAfterSleep,
  setSafeTimeout,
  clearAllTimers,
  activeTimers,
} = require('../utils')
const { DEFAULT_CONFIG } = require('../config')

describe('utils.js', () => {
  // === sanitizeSessionID (3 cases) ===
  describe('sanitizeSessionID', () => {
    it('should keep alphanumeric unchanged', () => {
      assert.strictEqual(sanitizeSessionID('abc-123_XYZ'), 'abc-123_XYZ')
    })

    it('should replace special chars with underscore', () => {
      assert.strictEqual(sanitizeSessionID('hello/world!foo'), 'hello_world_foo')
    })

    it('should return unknown for non-string input', () => {
      assert.strictEqual(sanitizeSessionID(null), 'unknown')
      assert.strictEqual(sanitizeSessionID(undefined), 'unknown')
      assert.strictEqual(sanitizeSessionID(123), 'unknown')
    })
  })

  // === estimateContextTokens (5 cases) ===
  describe('estimateContextTokens', () => {
    it('should calculate base context correctly', () => {
      const state = { toolCallHistory: [], exchangeCount: 0 }
      const result = estimateContextTokens(state, DEFAULT_CONFIG)
      assert.strictEqual(result, 4000)
    })

    it('should add tool and exchange tokens', () => {
      const state = {
        toolCallHistory: [{ name: 'edit', time: 1, status: 'ok' }],
        exchangeCount: 5,
      }
      const result = estimateContextTokens(state, DEFAULT_CONFIG)
      assert.strictEqual(result, 4000 + 1000 + 2500) // base + tool(1x1000) + exchange(5x500)
    })

    it('should handle empty history', () => {
      const state = {}
      const result = estimateContextTokens(state, DEFAULT_CONFIG)
      assert.strictEqual(result, 4000)
    })

    it('should cap at effectiveMaxContext', () => {
      const state = {
        toolCallHistory: Array(50).fill({ name: 'edit', time: 1, status: 'ok' }),
        exchangeCount: 100,
      }
      const config = { effectiveMaxContext: 32000 }
      const result = estimateContextTokens(state, config)
      assert.strictEqual(result, 32000)
    })

    it('should independently count exchangeCount from toolCallHistory', () => {
      const state1 = { toolCallHistory: [{ name: 'edit', time: 1, status: 'ok' }], exchangeCount: 5 }
      const state2 = { ...state1, exchangeCount: 0 }
      assert.notStrictEqual(
        estimateContextTokens(state1, DEFAULT_CONFIG),
        estimateContextTokens(state2, DEFAULT_CONFIG)
      )
    })
  })

  // === estimateProcessTime (2 cases) ===
  describe('estimateProcessTime', () => {
    it('should calculate process time correctly', () => {
      const result = estimateProcessTime(32000, 50)
      // (32000 / 50) * 1000 * 1.5 = 960000
      assert.strictEqual(result, 960000)
    })

    it('should return 0 for zero speed', () => {
      assert.strictEqual(estimateProcessTime(32000, 0), 0)
      assert.strictEqual(estimateProcessTime(32000, -1), 0)
    })
  })

  // === isWakeAfterSleep (1 case) ===
  describe('isWakeAfterSleep', () => {
    it('should detect sleep wake correctly', () => {
      const now = Date.now()
      assert.strictEqual(isWakeAfterSleep(now - 1000), false)   // normal
      assert.strictEqual(isWakeAfterSleep(now - 35000), true)   // sleep wake
    })
  })
})
