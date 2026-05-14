// phase4-integration.test.js — Integration Tests (4 cases)
const assert = require('assert')
const { describe, it } = require('node:test')
const path = require('path')
const { registerHandlers, getSessionID } = require('../index')
const { createOrGetState, getState, getStatesMap, removeState } = require('../state')
const { activeTimers, setSafeTimeout, clearAllTimers } = require('../utils')
const { DEFAULT_CONFIG } = require('../config')

describe('Integration', () => {
  // === registerHandlers wiring ===
  it('should register 4 core event handlers', () => {
    const mockClient = {
      _handlers: {},
      handlerCount: 0,
      on(event, handler) {
        this._handlers[event] = handler
        this.handlerCount++
        return { off: () => { delete this._handlers[event] } }
      },
    }

    const handlers = registerHandlers(mockClient, DEFAULT_CONFIG)
    assert(handlers.length >= 4, 'Phase 2 should register tool.started/completed/error + message.completed')
    handlers.forEach(h => assert.strictEqual(typeof h.off, 'function'))
  })

  // === getSessionID compatibility ===
  it('should extract sessionID from various payload formats', () => {
    assert.strictEqual(getSessionID({ properties: { sessionID: 'prop-ses' } }), 'prop-ses')
    assert.strictEqual(getSessionID({ info: { sessionID: 'info-ses' } }), 'info-ses')
    assert.strictEqual(getSessionID({ sessionID: 'direct-ses' }), 'direct-ses')
    assert.strictEqual(getSessionID({}), undefined)
  })

  // === timer cleanup ===
  it('should clear all timers on cleanup', () => {
    setSafeTimeout(() => {}, 50000)
    setSafeTimeout(() => {}, 100000)
    assert(activeTimers.size > 0)

    clearAllTimers()
    assert.strictEqual(activeTimers.size, 0)
  })

  // === session state isolation ===
  it('should maintain independent states for different sessions', () => {
    const s1 = createOrGetState('session-alpha')
    const s2 = createOrGetState('session-beta')

    s1.toolErrorCount = 5
    s2.repeatedToolCount = 3

    assert.strictEqual(getState('session-alpha').toolErrorCount, 5)
    assert.strictEqual(getState('session-alpha').repeatedToolCount, 0)
    assert.strictEqual(getState('session-beta').toolErrorCount, 0)
    assert.strictEqual(getState('session-beta').repeatedToolCount, 3)

    // Cleanup
    removeState('session-alpha')
    removeState('session-beta')
  })
})
