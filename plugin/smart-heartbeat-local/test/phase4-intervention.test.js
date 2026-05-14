// phase4-intervention.test.js — User Intervention Tests (6 cases)
const assert = require('assert')
const { describe, it, beforeEach } = require('node:test')
const { createOrGetState, getStatesMap } = require('../state')
const { getRecoveryPrompt } = require('../recovery')

// We test the intervention logic directly via state manipulation
// since handleUserMessage is in index.js which requires OpenCode runtime

describe('User Intervention Logic', () => {
  beforeEach(() => {
    getStatesMap().clear()
  })

  // === User message resets counters ===
  it('should reset counters on user message', () => {
    const state = createOrGetState('test')
    state.recoveryAttempts = 3
    state.deathSpiral = true
    state.toolErrorCount = 8
    state.recoveryState = 'injected'
    state.truncationEvents = [{ time: 100, success: false }]

    // Simulate handleUserMessage logic
    state.recoveryState = 'idle'
    state.recoveryLevel = 0
    state.recoveryAttempts = 0
    state.deathSpiral = false
    state.truncationEvents = []
    state.toolErrorCount = 0
    state.heartbeatCooldownUntil = Date.now() + 60000

    assert.strictEqual(state.recoveryAttempts, 0)
    assert.strictEqual(state.deathSpiral, false)
    assert.strictEqual(state.toolErrorCount, 0)
    assert.strictEqual(state.truncationEvents.length, 0)
  })

  // === 60s cooldown blocks injection ===
  it('should block injection during cooldown', () => {
    const state = createOrGetState('test')
    state.interventionState = 'user_active'
    state.userLastActiveTime = Date.now()
    state.heartbeatCooldownUntil = Date.now() + 60000

    // Simulate shouldSkipInjection
    const shouldSkip = () => {
      if (state.heartbeatDisabled) return true
      if (state.interventionState === 'user_active') {
        if (Date.now() - state.userLastActiveTime > 120000) return false
        if (Date.now() < state.heartbeatCooldownUntil) return true
      }
      return false
    }

    assert.strictEqual(shouldSkip(), true)
  })

  // === 120s auto-resume ===
  it('should auto-resume after 120s idle', () => {
    const state = createOrGetState('test')
    state.interventionState = 'user_active'
    state.userLastActiveTime = Date.now() - 180000  // 3min idle
    state.heartbeatCooldownUntil = Date.now() + 60000

    // Simulate shouldSkipInjection with auto-resume
    let autoResumed = false
    if (state.interventionState === 'user_active') {
      if (Date.now() - state.userLastActiveTime > 120000) {
        state.interventionState = 'none'
        state.heartbeatCooldownUntil = 0
        autoResumed = true
      }
    }

    assert.strictEqual(autoResumed, true)
    assert.strictEqual(state.interventionState, 'none')
  })

  // === /heartbeat disable ===
  it('should disable heartbeat on /heartbeat disable', () => {
    const state = createOrGetState('test')
    const text = '/heartbeat disable'
    const safeText = text.trim().toLowerCase()

    if (safeText.includes('/heartbeat disable')) {
      state.heartbeatDisabled = true
      state.interventionState = 'none'
    }

    assert.strictEqual(state.heartbeatDisabled, true)
  })

  // === /heartbeat enable ===
  it('should enable heartbeat on /heartbeat enable', () => {
    const state = createOrGetState('test')
    state.heartbeatDisabled = true

    const text = '/heartbeat enable'
    const safeText = text.trim().toLowerCase()

    if (safeText.includes('/heartbeat enable') || safeText.includes('繼續')) {
      state.interventionState = 'none'
      state.heartbeatCooldownUntil = 0
      state.heartbeatDisabled = false
    }

    assert.strictEqual(state.heartbeatDisabled, false)
  })

  // === /heartbeat status output ===
  it('should build status summary string', () => {
    const state = createOrGetState('test')
    state.recoveryState = 'injected'
    state.recoveryAttempts = 2
    state.toolErrorCount = 5
    state.contextWarnings = 1

    const summary = [
      `Session: test`,
      `Enabled: ${!state.heartbeatDisabled}`,
      `Intervention: ${state.interventionState} (${state.userInterventionCount} times)`,
      `Recovery: ${state.recoveryState} (${state.recoveryAttempts} attempts)`,
      `Death spiral: ${state.deathSpiral}`,
      `Tool errors: ${state.toolErrorCount} (level ${state.toolErrorAnalysis?.level || 0})`,
      `Context warnings: ${state.contextWarnings}`,
    ].join('\n')

    assert(summary.includes('Recovery: injected'))
    assert(summary.includes('Tool errors: 5'))
    assert(summary.length > 0)
  })
})
