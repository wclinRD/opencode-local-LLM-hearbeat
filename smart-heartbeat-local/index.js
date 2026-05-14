// index.js — Smart Heartbeat Local LLM Plugin (Complete)
// Lifecycle: onStart / onStop
// Event routing: tool.started/completed/error + message.completed
// Injection decision loop: checkAndInject
// User intervention: /heartbeat commands + auto-resume

const fs = require('fs')
const path = require('path')

const { loadConfig, detectModelProfile, getPromptStyle } = require('./config')
const { makeLogger, getLogger, initLogger, clearAllTimers, activeTimers, readTodos, setSafeTimeout } = require('./utils')
const {
  createOrGetState, getState, getStatesMap, removeState,
  persistState, immediatePersist, persistDir,
  clearPersistenceDebounce, cleanStaleFiles, loadAllFromPersistence,
} = require('./state')
const {
  handleToolStarted, handleToolCompleted, handleToolError,
  handleMessageCompleted, updateContextPressure, detectTruncation,
} = require('./monitor')
const {
  shouldAttemptRecovery, executeRecovery, handleRecoverySuccess,
  clearRecoveryVerification, handleRecoveryFailure,
  analyzeToolErrors,
} = require('./recovery')
const { injectContinuation } = require('./injector')

// === Module-level state ===
let opencodeRef = null
let clientRef = null
let activeConfig = null
let eventHandlers = []

// === Task 4.1: Helper — getSessionID ===
function getSessionID(event) {
  return event.properties?.sessionID || event.info?.sessionID || event.sessionID
}

// === Task 4.1: registerHandlers (Phase 2 core handlers) ===
function registerHandlers(client, config) {
  const handlers = []

  handlers.push(client.on('tool.started', event => {
    const sid = getSessionID(event)
    if (!sid) return
    const state = getState(sid)
    if (!state) return
    handleToolStarted(state, event, config)
  }))

  handlers.push(client.on('tool.completed', event => {
    const sid = getSessionID(event)
    if (!sid) return
    const state = getState(sid)
    if (!state) return
    handleToolCompleted(state, event)
  }))

  handlers.push(client.on('tool.error', event => {
    const sid = getSessionID(event)
    if (!sid) return
    const state = getState(sid)
    if (!state) return
    handleToolError(state, event)
  }))

  handlers.push(client.on('message.completed', event => {
    const sid = getSessionID(event)
    if (!sid) return
    const state = getState(sid)
    if (!state) return
    handleMessageCompleted(state, event)
  }))

  return handlers
}

// === Task 4.4: showStatusToUser ===
function showStatusToUser(summary) {
  try {
    if (typeof opencodeRef?.showToast === 'function') {
      opencodeRef.showToast(summary, 'info')
    }
  } catch (_) {}
  const logger = getLogger()
  logger.log(`[STATUS]\n${summary}`)
}

// === Task 4.4: buildStatusSummary ===
function buildStatusSummary(state, sessionID) {
  return [
    `Session: ${sessionID}`,
    `Enabled: ${!state.heartbeatDisabled}`,
    `Intervention: ${state.interventionState} (${state.userInterventionCount} times)`,
    `Recovery: ${state.recoveryState} (${state.recoveryAttempts} attempts)`,
    `Death spiral: ${state.deathSpiral}`,
    `Tool errors: ${state.toolErrorCount} (level ${state.toolErrorAnalysis?.level || 0})`,
    `Context warnings: ${state.contextWarnings}`,
    `Recovery quality: ${state.recoveryQuality}`,
    `Processing guard: ${state.processingGuard}`,
    `Cooldown: ${state.heartbeatCooldownUntil > Date.now() ? Math.ceil((state.heartbeatCooldownUntil - Date.now()) / 1000) + 's' : 'none'}`,
  ].join('\n')
}

// === Task 4.4: autoNotify ===
function autoNotify(state, sessionID) {
  const triggers = []
  if (state.deathSpiral) triggers.push('死亡螺旋偵測，復原已停止')
  if (state.recoveryState === 'stopped') triggers.push('復原已達上限，等待使用者介入')
  if (state.toolErrorCount >= 8) triggers.push(`tool 錯誤 ${state.toolErrorCount} 次`)
  if (triggers.length === 0) return

  const msg = `[Heartbeat] ${triggers.join('; ')}`
  try {
    if (typeof opencodeRef?.showToast === 'function') opencodeRef.showToast(msg, 'warn')
  } catch (_) {}
  const logger = getLogger()
  logger.warn(`[NOTIFY] [${sessionID}] ${msg}`)
}

// === Task 4.3: shouldSkipInjection ===
function shouldSkipInjection(state) {
  if (state.heartbeatDisabled) return true
  if (state.interventionState === 'user_active') {
    const idleTime = Date.now() - state.userLastActiveTime
    if (idleTime > 120000) {
      state.interventionState = 'none'
      state.heartbeatCooldownUntil = 0
      return false
    }
    if (Date.now() < state.heartbeatCooldownUntil) return true
  }
  return false
}

// === Task 4.4: handleUserMessage ===
function handleUserMessage(state, text, sessionID) {
  clearRecoveryVerification(state)

  state.interventionState = 'user_active'
  state.userLastActiveTime = Date.now()
  state.userInterventionCount++

  // Full counter reset
  state.recoveryState = 'idle'
  state.recoveryLevel = 0
  state.recoveryAttempts = 0
  state.deathSpiral = false
  state.truncationEvents = []
  state.toolErrorCount = 0
  state.toolErrorAnalysis = { level: 0, pattern: 'none', toolType: null, errorCount: 0, consecutiveSameTool: false, lastErrorTool: null }
  state.webSearchSuggested = false
  state.consecutiveFailures = 0
  state.stuckCount = 0

  // 60s cooldown
  state.heartbeatCooldownUntil = Date.now() + 60000

  // Parse commands
  const safeText = (text || '').trim().toLowerCase()
  if (!safeText) return

  if (safeText.includes('/heartbeat disable')) {
    state.heartbeatDisabled = true
    state.interventionState = 'none'
    return
  }
  if (safeText.includes('/heartbeat enable') || safeText.includes('繼續')) {
    state.interventionState = 'none'
    state.heartbeatCooldownUntil = 0
    state.heartbeatDisabled = false
    return
  }
  if (safeText.includes('/heartbeat status')) {
    const summary = buildStatusSummary(state, sessionID)
    showStatusToUser(summary)
    return
  }
}

// === Task 4.5: checkAndInject — injection decision loop ===
let previousTodosForSession = {}

async function checkAndInject(sessionID) {
  const state = getState(sessionID)
  if (!state) return

  // Unified skip check
  if (shouldSkipInjection(state)) return

  // Processing guard with timeout release
  if (state.processingGuard) {
    const guardAge = Date.now() - (state.lastInjectionTime || 0)
    if (guardAge > Math.max(activeConfig.countdownSeconds * 1000 * 2, 120000)) {
      try { if (typeof opencodeRef?.showToast === 'function') opencodeRef.showToast(`[GUARD] force-release stale guard after ${Math.round(guardAge/1000)}s`, 'warn') } catch (_) {}
      state.processingGuard = false
    } else {
      return
    }
  }

  // In-flight tool check (any tool type, not just 'task')
  if (state.inFlightTool) {
    if (Date.now() - state.inFlightTool.startTime > state.inFlightTool.timeout) {
      try { if (typeof opencodeRef?.showToast === 'function') opencodeRef.showToast(`[TOOL] in-flight ${state.inFlightTool.name} timed out for ${sessionID}`, 'warn') } catch (_) {}
      state.inFlightTool = null
      state.waitingForTool = false
    } else {
      return
    }
  }

  // Busy check: skip if LLM actively processing (recent tool activity)
  if (state.lastToolTime && Date.now() - state.lastToolTime < 30000) {
    return
  }

  // Read todos via adapter
  const todos = await readTodos(clientRef, opencodeRef, sessionID, persistDir)

  if (todos.length === 0) {
    const currentSnapshot = []
    const prevSnapshot = previousTodosForSession[sessionID] || []
    const truncResult = detectTruncation(state, prevSnapshot, currentSnapshot, activeConfig)
    previousTodosForSession[sessionID] = currentSnapshot
    if (truncResult.truncated && shouldAttemptRecovery(state, activeConfig)) {
      await executeRecovery(sessionID, state, todos, clientRef, activeConfig)
    }
    return
  }

  // Step 1: Truncation detection
  const currentSnapshot = todos.map(t => ({ content: t.content, status: t.status }))
  const prevSnapshot = previousTodosForSession[sessionID] || []
  const truncResult = detectTruncation(state, prevSnapshot, currentSnapshot, activeConfig)
  previousTodosForSession[sessionID] = currentSnapshot

  if (truncResult.truncated) {
    try { if (typeof opencodeRef?.showToast === 'function') opencodeRef.showToast(`[TRUNC] 偵測到截斷 (${truncResult.method}, 信心: ${Math.round(truncResult.confidence * 100)}%)`, 'warn') } catch (_) {}
    if (shouldAttemptRecovery(state, activeConfig)) {
      executeRecovery(sessionID, state, todos, clientRef, activeConfig)
    }
    return
  }

  // Step 2: Recovery state machine
  if (state.recoveryState !== 'idle') {
    if (shouldAttemptRecovery(state, activeConfig)) {
      executeRecovery(sessionID, state, todos, clientRef, activeConfig)
    }
    return
  }

  // Step 3: Normal continuation
  await injectContinuation(sessionID, state, todos, clientRef, activeConfig)
}

// === Task 4.1: handlePluginCrash ===
function handlePluginCrash(err) {
  try {
    const logger = getLogger()
    logger.err('[FATAL] smart-heartbeat-local crashed:', err.message)
    logger.err('[FATAL] stack:', err.stack)
    clearAllTimers()
  } catch (_) {}
}

// === Task 4.2: safeOnStop ===
async function safeOnStop(steps) {
  for (const [name, fn, timeoutMs] of steps) {
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timeout`)), timeoutMs))
      ])
    } catch (e) {
      const logger = getLogger()
      logger.warn(`[SHUTDOWN] step ${name} failed: ${e.message}`)
    }
  }
}

// === onStop: persist all states ===
async function persistAllStates() {
  const writes = []
  for (const [sid, state] of getStatesMap().entries()) {
    clearPersistenceDebounce(sid)
    writes.push(immediatePersist(sid, state))
  }
  await Promise.all(writes)
}

// === Plugin Entry ===
module.exports = {
  getSessionID,
  registerHandlers,

  // === Task 4.1: onStart ===
  onStart: async (opencode, client) => {
    opencodeRef = opencode
    clientRef = client

    // Load config first
    const { config, errors } = loadConfig(opencode)
    activeConfig = config
    initLogger(config.logLevel)
    const logger = getLogger()

    if (errors.length > 0) {
      for (const e of errors) { try { client.tui.showToast({ body: { message: `[CONFIG] ${e}`, variant: 'warn' } }) } catch (_) {} }
    }

    // Safety: clean orphaned timers
    if (activeTimers.size > 0) {
      try { client.tui.showToast({ body: { message: `[STARTUP] ${activeTimers.size} orphaned timers, cleaning up`, variant: 'warn' } }) } catch (_) {}
      clearAllTimers()
    }

    // Install crash handlers
    process.on('uncaughtException', handlePluginCrash)
    process.on('unhandledRejection', handlePluginCrash)

    // Setup persistence directory
    try {
      const pd = typeof persistDir === 'string' ? persistDir : '.opencode/heartbeat-state/'
      await fs.promises.mkdir(path.resolve(process.cwd(), pd), { recursive: true })
      cleanStaleFiles()
    } catch (e) {
      try { client.tui.showToast({ body: { message: `persistence disabled: ${e.message.slice(0,60)}`, variant: 'warn' } }) } catch (_) {}
    }

    // Restore states from disk
    try {
      await loadAllFromPersistence()
    } catch (_) {}

    // Register event handlers
    eventHandlers = registerHandlers(client, config)

    // Register recovery verification hook (tool.started → recovery verified)
    eventHandlers.push(client.on('tool.started', event => {
      const sid = getSessionID(event)
      if (!sid) return
      const state = getState(sid)
      if (!state) return
      if (state.recoveryState === 'injected') {
        clearRecoveryVerification(state)
        handleRecoverySuccess(state, event)
        try { client.tui.showToast({ body: { message: `[OK] [${sid}] recovery verified`, variant: 'info' } }) } catch (_) {}
      }
    }))

    // Register injection hook (tool.completed → checkAndInject)
    eventHandlers.push(client.on('tool.completed', async event => {
      const sid = getSessionID(event)
      if (!sid) return
      try {
        await checkAndInject(sid)
      } catch (e) {
        try { client.tui.showToast({ body: { message: `[INJECT] checkAndInject error: ${e.message.slice(0,50)}`, variant: 'error' } }) } catch (_) {}
      }
    }))

    // Register user intervention handler
    eventHandlers.push(client.on('message.completed', event => {
      const sid = getSessionID(event)
      if (!sid) return
      const state = getState(sid)
      if (!state) return
      const role = event.info?.role || event.properties?.role
      if (role !== 'user') return
      const text = event.text || event.info?.text || event.properties?.text || ''
      handleUserMessage(state, text, sid)
    }))

    // Log startup
    logger.log(`[OK] smart-heartbeat-local v1 started (model: ${detectModelProfile(opencode)})`)
  },

  // === Task 4.2: onStop ===
  onStop: async () => {
    // Remove crash handlers
    process.off('uncaughtException', handlePluginCrash)
    process.off('unhandledRejection', handlePluginCrash)

    // Unregister handlers
    eventHandlers.forEach(h => { try { h.off() } catch (_) {} })
    eventHandlers = []

    // Safe onStop with timeout per step
    await safeOnStop([
      ['clearTimers', () => clearAllTimers(), 500],
      ['persistAll', () => persistAllStates(), 3000],
      ['cleanup', () => {
        const logger = getLogger()
        logger.log('[OK] shutdown complete')
      }, 1000],
    ])
  },
}
