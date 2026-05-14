// phase2-monitor.test.js — Monitor Unit Tests (12 cases)
const assert = require('assert')
const { describe, it, beforeEach } = require('node:test')
const {
  handleToolStarted,
  handleToolCompleted,
  handleToolError,
  checkStuckState,
  detectTruncation,
  updateContextPressure,
} = require('../monitor')
const { createOrGetState, getStatesMap } = require('../state')
const { DEFAULT_CONFIG } = require('../config')

const TEST_CONFIG = { ...DEFAULT_CONFIG, maxRepeatedTool: 10, maxToolErrors: 8, maxIdleSeconds: 120 }

describe('monitor.js', () => {
  beforeEach(() => {
    getStatesMap().clear()
  })

  // === handleToolStarted (2 cases) ===
  describe('handleToolStarted', () => {
    it('should record tool name and time', () => {
      const state = createOrGetState('test')
      handleToolStarted(state, { properties: { name: 'edit' } }, TEST_CONFIG)
      assert.strictEqual(state.lastToolName, 'edit')
      assert(state.lastToolTime > 0)
      assert.strictEqual(state.processingGuard, false)
    })

    it('should track repeated tools', () => {
      const state = createOrGetState('test2')
      handleToolStarted(state, { properties: { name: 'edit' } }, TEST_CONFIG)
      handleToolStarted(state, { properties: { name: 'edit' } }, TEST_CONFIG)
      assert.strictEqual(state.repeatedToolCount, 1)
      handleToolStarted(state, { properties: { name: 'bash' } }, TEST_CONFIG)
      assert.strictEqual(state.repeatedToolCount, 0)
    })
  })

  // === handleToolCompleted (2 cases) ===
  describe('handleToolCompleted', () => {
    it('should record completion and clear context cache', () => {
      const state = createOrGetState('test')
      state._cachedContextSize = 12345
      handleToolCompleted(state, { properties: { name: 'edit' } })
      assert.strictEqual(state.toolCallHistory.length, 1)
      assert.strictEqual(state.toolCallHistory[0].status, 'ok')
      assert.strictEqual(state._cachedContextSize, undefined)
    })

    it('should release in-flight tool', () => {
      const state = createOrGetState('test')
      state.inFlightTool = { name: 'bash', startTime: Date.now(), timeout: 60000 }
      state.waitingForTool = true
      handleToolCompleted(state, { properties: { name: 'bash' } })
      assert.strictEqual(state.inFlightTool, null)
      assert.strictEqual(state.waitingForTool, false)
    })
  })

  // === handleToolError (2 cases) ===
  describe('handleToolError', () => {
    it('should accumulate error count', () => {
      const state = createOrGetState('test')
      for (let i = 0; i < 5; i++) {
        handleToolError(state, { properties: { name: 'bash', error: 'fail' } })
      }
      assert.strictEqual(state.toolErrorCount, 5)
      assert.strictEqual(state.toolErrorsByTool.bash, 5)
    })

    it('should track errors by tool type', () => {
      const state = createOrGetState('test')
      handleToolError(state, { properties: { name: 'bash', error: 'e1' } })
      handleToolError(state, { properties: { name: 'edit', error: 'e2' } })
      handleToolError(state, { properties: { name: 'bash', error: 'e3' } })
      assert.strictEqual(state.toolErrorsByTool.bash, 2)
      assert.strictEqual(state.toolErrorsByTool.edit, 1)
    })
  })

  // === checkStuckState (2 cases) ===
  describe('checkStuckState', () => {
    it('should detect tool_loop', () => {
      const state = createOrGetState('test')
      state.repeatedToolCount = 10
      state.lastToolName = 'edit'
      const result = checkStuckState(state, [], TEST_CONFIG)
      assert.strictEqual(result.stuck, true)
      assert.strictEqual(result.reason, 'tool_loop')
    })

    it('should detect tool_errors and idle', () => {
      const state = createOrGetState('test')
      state.toolErrorCount = 8
      let result = checkStuckState(state, [], TEST_CONFIG)
      assert.strictEqual(result.stuck, true)
      assert.strictEqual(result.reason, 'tool_errors')

      state.toolErrorCount = 0
      state.lastToolTime = Date.now() - 180000  // 3 min ago
      result = checkStuckState(state, [], TEST_CONFIG)
      assert.strictEqual(result.stuck, true)
      assert.strictEqual(result.reason, 'idle')
    })
  })

  // === detectTruncation (4 cases) ===
  describe('detectTruncation', () => {
    it('Method 1: should detect todo_regression', () => {
      const state = createOrGetState('test')
      const prevTodos = [
        { content: 'task A', status: 'in_progress' },
        { content: 'task B', status: 'pending' },
      ]
      const currTodos = [
        { content: 'task A', status: 'pending' },
        { content: 'task B', status: 'pending' },
      ]
      const r = detectTruncation(state, prevTodos, currTodos, TEST_CONFIG)
      assert.strictEqual(r.truncated, true)
      assert.strictEqual(r.method, 'todo_regression')
      assert.strictEqual(r.confidence, 0.8)
    })

    it('Method 2: should detect repeated_calls', () => {
      const state = createOrGetState('test')
      state.toolCallHistory = [
        { name: 'edit', time: 1000, status: 'ok' },
        { name: 'edit', time: 2000, status: 'ok' },
        { name: 'edit', time: 3000, status: 'ok' },
        { name: 'edit', time: 4000, status: 'ok' },
        { name: 'edit', time: 5000, status: 'ok' },
        { name: 'edit', time: 6000, status: 'ok' },
      ]
      const r = detectTruncation(state, null, null, TEST_CONFIG)
      assert.strictEqual(r.truncated, true)
      assert.strictEqual(r.method, 'repeated_calls')
    })

    it('Method 3: should detect context_drop', () => {
      const state = createOrGetState('test')
      state._cachedContextSize = 15000
      state._previousContextSize = 20000  // drop of 5000
      const r = detectTruncation(state, null, null, TEST_CONFIG)
      // This should work because _previousContextSize is set and drop > 3000
      // But first call sets _previousContextSize, so we need to call twice
      assert.strictEqual(r.truncated, true)
      assert.strictEqual(r.method, 'context_drop')
    })

    it('should return false when no truncation', () => {
      const state = createOrGetState('test')
      state.toolCallHistory = [{ name: 'edit', time: 1000, status: 'ok' }]
      const r = detectTruncation(state, null, null, TEST_CONFIG)
      assert.strictEqual(r.truncated, false)
    })
  })
})
