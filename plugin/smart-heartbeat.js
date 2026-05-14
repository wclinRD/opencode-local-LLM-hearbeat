// smart-heartbeat.js — OpenCode Desktop Plugin Entry
// Bridges smart-heartbeat-local modules to OpenCode plugin API.
// Single factory function: module.exports = async (ctx) => { ... }
// Place this file directly in .opencode/plugins/ for auto-discovery.
//
// Install: cp plugin/smart-heartbeat.js <project>/.opencode/plugins/
//          cp -r plugin/smart-heartbeat-local <project>/.opencode/plugins/
//
// The `smart-heartbeat-local/` subdirectory must be adjacent to this file.

const path = require('path')
const fs = require('fs')

// === Guard: prevent double initialization when both auto-discovery and config.plugin load ===
let _initialized = false

// Subdirectory modules — relative to this file's location
const BASE = './smart-heartbeat-local'
const { loadConfig, detectModelProfile } = require(path.join(__dirname, BASE, 'config.js'))
const { initLogger, getLogger, clearAllTimers, activeTimers, readTodos } = require(path.join(__dirname, BASE, 'utils.js'))
const {
  createOrGetState, getState, getStatesMap, removeState,
  persistState, immediatePersist, persistDir,
  clearPersistenceDebounce, cleanStaleFiles, loadAllFromPersistence,
} = require(path.join(__dirname, BASE, 'state.js'))
const {
  handleToolStarted, handleToolCompleted, handleToolError,
  handleMessageCompleted, detectTruncation,
} = require(path.join(__dirname, BASE, 'monitor.js'))
const {
  shouldAttemptRecovery, executeRecovery, handleRecoverySuccess,
  clearRecoveryVerification, handleRecoveryFailure,
} = require(path.join(__dirname, BASE, 'recovery.js'))
const { injectContinuation } = require(path.join(__dirname, BASE, 'injector.js'))

// === Module-level state ===
let clientRef = null
let activeConfig = null
let eventHandlers = []
let previousTodosForSession = {}

// === getSessionID ===
function getSessionID(event) {
  return event.properties?.sessionID || event.info?.sessionID || event.sessionID
}

// === registerHandlers (4 core events) ===
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

// === showStatusToUser ===
function showStatusToUser(summary) {
  try {
    if (typeof clientRef?.showToast === 'function') {
      clientRef.showToast(summary, 'info')
    }
  } catch (_) {}
  getLogger().log(`[STATUS]\n${summary}`)
}

// === buildStatusSummary ===
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

// === autoNotify ===
function autoNotify(state, sessionID) {
  const triggers = []
  if (state.deathSpiral) triggers.push('death spiral detected, recovery stopped')
  if (state.recoveryState === 'stopped') triggers.push('recovery maxed, waiting for user')
  if (state.toolErrorCount >= 8) triggers.push(`tool errors: ${state.toolErrorCount}`)
  if (triggers.length === 0) return
  const msg = `[Heartbeat] ${triggers.join('; ')}`
  try {
    if (typeof clientRef?.showToast === 'function') clientRef.showToast(msg, 'warn')
  } catch (_) {}
  getLogger().warn(`[NOTIFY] [${sessionID}] ${msg}`)
}

// === shouldSkipInjection ===
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

// === handleUserMessage ===
function handleUserMessage(state, text, sessionID) {
  clearRecoveryVerification(state)
  state.interventionState = 'user_active'
  state.userLastActiveTime = Date.now()
  state.userInterventionCount++
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
  state.heartbeatCooldownUntil = Date.now() + 60000
  const safeText = (text || '').trim().toLowerCase()
  if (!safeText) return
  if (safeText.includes('/heartbeat disable')) {
    state.heartbeatDisabled = true
    state.interventionState = 'none'
    return
  }
  if (safeText.includes('/heartbeat enable') || safeText.includes('continue')) {
    state.interventionState = 'none'
    state.heartbeatCooldownUntil = 0
    state.heartbeatDisabled = false
    return
  }
  if (safeText.includes('/heartbeat status')) {
    showStatusToUser(buildStatusSummary(state, sessionID))
    return
  }
}

// === checkAndInject — injection decision loop ===
async function checkAndInject(sessionID) {
  const state = getState(sessionID)
  if (!state) return
  if (shouldSkipInjection(state)) return

  if (state.processingGuard) {
    const guardAge = Date.now() - (state.lastInjectionTime || 0)
    if (guardAge > Math.max(activeConfig.countdownSeconds * 1000 * 2, 120000)) {
      getLogger().warn(`[GUARD] force-release stale processingGuard after ${guardAge}ms for ${sessionID}`)
      state.processingGuard = false
    } else {
      return
    }
  }

  if (state.waitingForTool) {
    if (!(state.inFlightTool && Date.now() - state.inFlightTool.startTime > state.inFlightTool.timeout)) return
    getLogger().warn(`[INJECT] in-flight tool ${state.inFlightTool.name} timed out for ${sessionID}`)
  }

  const todos = await readTodos(clientRef, clientRef, sessionID, persistDir)
  if (todos.length === 0) {
    const prev = previousTodosForSession[sessionID] || []
    const truncResult = detectTruncation(state, prev, [], activeConfig)
    previousTodosForSession[sessionID] = []
    if (truncResult.truncated && shouldAttemptRecovery(state, activeConfig)) {
      await executeRecovery(sessionID, state, todos, clientRef, activeConfig)
    }
    return
  }

  const currentSnapshot = todos.map(t => ({ content: t.content, status: t.status }))
  const prevSnapshot = previousTodosForSession[sessionID] || []
  const truncResult = detectTruncation(state, prevSnapshot, currentSnapshot, activeConfig)
  previousTodosForSession[sessionID] = currentSnapshot

  if (truncResult.truncated) {
    getLogger().log(`[TRUNC] detected via ${truncResult.method} (confidence: ${truncResult.confidence}) for ${sessionID}`)
    if (shouldAttemptRecovery(state, activeConfig)) {
      executeRecovery(sessionID, state, todos, clientRef, activeConfig)
    }
    return
  }

  if (state.recoveryState !== 'idle') {
    if (shouldAttemptRecovery(state, activeConfig)) {
      executeRecovery(sessionID, state, todos, clientRef, activeConfig)
    }
    return
  }

  await injectContinuation(sessionID, state, todos, clientRef, activeConfig)
}

// === Crash handlers ===
function handlePluginCrash(err) {
  try {
    getLogger().err('[FATAL] smart-heartbeat-local crashed:', err.message)
    clearAllTimers()
  } catch (_) {}
}

// === Cleanup ===
async function persistAllStates() {
  const writes = []
  for (const [sid, state] of getStatesMap().entries()) {
    clearPersistenceDebounce(sid)
    writes.push(immediatePersist(sid, state))
  }
  await Promise.all(writes)
}

async function safeOnStop(steps) {
  for (const [name, fn, timeoutMs] of steps) {
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timeout`)), timeoutMs))
      ])
    } catch (e) {
      getLogger().warn(`[SHUTDOWN] step ${name} failed: ${e.message}`)
    }
  }
}

// ===================================================================
// Plugin Entry — single factory function for OpenCode Desktop API
// ===================================================================
module.exports = async function smartHeartbeat(ctx) {
  // === Guard: skip if already initialized (e.g., auto-discovery + config.plugin) ===
  if (_initialized) {
    try { getLogger()?.log('[GUARD] already initialized, skipping duplicate load') } catch (_) {}
    return {}
  }
  _initialized = true

  // ctx = { client, project, directory, worktree, serverUrl, $, config }
  clientRef = ctx.client

  // Load config (ctx.config is the OpenCode config, may have heartbeat.*)
  const { config, errors } = loadConfig(ctx)
  activeConfig = config
  initLogger(config.logLevel)
  const logger = getLogger()
  if (errors.length > 0) {
    for (const e of errors) logger.warn(`[CONFIG] ${e}`)
  }

  // Clean orphaned timers
  if (activeTimers.size > 0) {
    logger.warn(`[STARTUP] ${activeTimers.size} orphaned timers, cleaning up`)
    clearAllTimers()
  }

  // Crash safety
  process.on('uncaughtException', handlePluginCrash)
  process.on('unhandledRejection', handlePluginCrash)

  // Persistence directory
  try {
    const pd = typeof persistDir === 'string' ? persistDir : '.opencode/heartbeat-state/'
    await fs.promises.mkdir(path.resolve(process.cwd(), pd), { recursive: true })
    cleanStaleFiles()
  } catch (e) {
    logger.warn(`persistence disabled: ${e.message}`)
  }

  // Restore states from disk
  try { await loadAllFromPersistence() } catch (_) {}

  // Register core event handlers (tool.started/completed/error, message.completed)
  eventHandlers = registerHandlers(ctx.client, config)

  // Recovery verification hook
  eventHandlers.push(ctx.client.on('tool.started', event => {
    const sid = getSessionID(event)
    if (!sid) return
    const state = getState(sid)
    if (!state) return
    if (state.recoveryState === 'injected') {
      clearRecoveryVerification(state)
      handleRecoverySuccess(state, event)
      logger.log(`[OK] [${sid}] recovery verified via tool.started`)
    }
    if (state.processingGuard) state.processingGuard = false
  }))

  // Injection loop hook
  eventHandlers.push(ctx.client.on('tool.completed', async event => {
    const sid = getSessionID(event)
    if (!sid) return
    // Cache todos from todowrite results
    if (event.properties?.name === 'todowrite') {
      const output = event.properties?.output || event.properties?.result || event.properties?.arguments
      if (output) {
        try {
          const parsed = typeof output === 'string' ? JSON.parse(output) : output
          const todos = Array.isArray(parsed) ? parsed : parsed?.todos ? parsed.todos : null
          if (todos && Array.isArray(todos) && todos.length > 0) {
            const state = getState(sid)
            if (state) {
              state._cachedTodos = todos.map(t => ({ content: t.content || t.name || '', status: t.status || 'pending' }))
              state._cachedTodosUpdated = Date.now()
            }
          }
        } catch (_) {}
      }
    }
    try { await checkAndInject(sid) }
    catch (e) { logger.err(`[INJECT] checkAndInject error for ${sid}: ${e.message}`) }
  }))

  // User intervention handler
  eventHandlers.push(ctx.client.on('message.completed', event => {
    const sid = getSessionID(event)
    if (!sid) return
    const state = getState(sid)
    if (!state) return
    if ((event.info?.role || event.properties?.role) !== 'user') return
    handleUserMessage(state, event.text || event.info?.text || event.properties?.text || '', sid)
  }))

  // ===== Periodic heartbeat timer (NEW) =====
  // Scans all sessions periodically when no tool events fire
  // Prevents heartbeat stall in local LLM mode where events may be unreliable
  const periodicMs = Math.max((activeConfig?.countdownSeconds || 30) * 1000, 10000)
  const periodicId = setInterval(() => {
    for (const [sid] of getStatesMap()) {
      checkAndInject(sid).catch(e => {
        try { getLogger()?.err(`[PERIODIC] checkAndInject error for ${sid}: ${e.message}`) } catch (_) {}
      })
    }
  }, periodicMs)
  // Ensure interval doesn't block process exit
  if (periodicId && typeof periodicId === 'object' && periodicId.unref) periodicId.unref()
  activeTimers.add(periodicId)

  logger.log(`[OK] smart-heartbeat-local v1 started (periodic=${periodicMs}ms, model: ${detectModelProfile(ctx)})`)

  // Return minimal hooks — event-based shutdown cleanup
  return {
      event: async ({ event }) => {
        if (event.type === 'session.shutdown' || event.type === 'app.shutdown') {
          // Clear periodic interval first
          clearInterval(periodicId)
          activeTimers.delete(periodicId)
          process.off('uncaughtException', handlePluginCrash)
          process.off('unhandledRejection', handlePluginCrash)
          eventHandlers.forEach(h => { try { h.off() } catch (_) {} })
          eventHandlers = []
          await safeOnStop([
            ['clearTimers', () => clearAllTimers(), 500],
            ['persistAll', () => persistAllStates(), 3000],
          ])
          getLogger().log('[OK] shutdown complete')
        }
      },
  }
}
