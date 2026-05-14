// state.js — Session State Management + Persistence
//
// Exports:
//   createOrGetState, getState, getStatesMap, removeState,
//   persistState, immediatePersist, buildPersistData, inflateStateFromPersist,
//   loadFromPersistence, loadAllFromPersistence,
//   cleanStaleFiles, clearPersistenceDebounce, persistDir

const path = require('path')
const fs = require('fs')
const { sanitizeSessionID, getLogger } = require('./utils')

const MAX_SESSIONS = 50
const states = new Map()  // Map<sessionID, State>
const _defaultPersistDir = '.opencode/heartbeat-state/'
function _getPersistDir() { return process.env.HEARTBEAT_PERSIST_DIR || _defaultPersistDir }
const debounceTimers = new Map()  // sessionID → setTimeout id

// === Task 2.1: createOrGetState ===
function createOrGetState(sessionID) {
  if (states.has(sessionID)) {
    const s = states.get(sessionID)
    s.lastActivity = Date.now()
    return s
  }

  // LRU eviction
  if (states.size >= MAX_SESSIONS) {
    const [oldestID] = [...states.entries()]
      .sort(([, a], [, b]) => (a.lastActivity || 0) - (b.lastActivity || 0))[0]
    removeState(oldestID)
  }

  const state = {
    // Identity
    sessionIDSafe: sanitizeSessionID(sessionID),
    lastActivity: Date.now(),

    // Tool monitoring
    toolCallHistory: [],
    toolErrorCount: 0,
    lastToolName: null,
    lastToolTime: null,
    repeatedToolCount: 0,
    toolCallCount: 0,
    inFlightTool: null,
    waitingForTool: false,

    // Context & processing
    lastInjectionTime: 0,
    estimatedProcessTime: 0,
    processingGuard: false,
    contextWarnings: 0,
    largeOutputCount: 0,

    // Exchange counting (FIX: independent from toolCallHistory)
    exchangeCount: 0,

    // Recovery state machine
    recoveryState: 'idle',
    recoveryLevel: 0,
    recoveryAttempts: 0,
    lastRecoveryTime: 0,
    recoveryVerificationStage1: null,
    recoveryVerificationStage2: null,
    recoveryQuality: 'unknown',
    truncationEvents: [],
    deathSpiral: false,
    lastToolBeforeTruncation: null,

    // Tool error analysis
    toolErrorAnalysis: { level: 0, pattern: 'none', toolType: null, errorCount: 0, consecutiveSameTool: false, lastErrorTool: null },
    toolErrorsByTool: {},
    webSearchSuggested: false,
    lastErrorEscalationTime: 0,

    // Legacy fields
    currentAgent: null,
    consecutiveFailures: 0,
    stuckCount: 0,
    inProgress: false,
    enabled: true,
    recoveryCount: 0,
    lastProgressFile: null,

    // User intervention
    interventionState: 'none',
    userLastActiveTime: 0,
    userInterventionCount: 0,
    heartbeatCooldownUntil: 0,
    heartbeatDisabled: false,
    resumePending: false,
  }

  states.set(sessionID, state)
  return state
}

function getState(sessionID) {
  return states.get(sessionID)
}

function getStatesMap() { return states }

// === Task 2.3: removeState ===
function removeState(sessionID) {
  if (states.has(sessionID)) {
    clearPersistenceDebounce(sessionID)
    states.delete(sessionID)
  }
}

// === Task 2.2: Persistence ===

function buildPersistData(sessionID, state) {
  return {
    sessionID,
    version: 2,
    updated: new Date().toISOString(),
    incomplete: state.toolCallHistory.filter(t => t.status !== 'completed'),
    currentTask: state.lastToolName,
    toolErrorCount: state.toolErrorCount,
    toolCallCount: state.toolCallCount,
    repeatedToolCount: state.repeatedToolCount,
    exchangeCount: state.exchangeCount,
    recoveryState: state.recoveryState || 'idle',
    recoveryAttempts: state.recoveryAttempts || 0,
    recoveryLevel: state.recoveryLevel || 0,
    deathSpiral: state.deathSpiral || false,
    lastRecoveryTime: state.lastRecoveryTime || 0,
    recoveryQuality: state.recoveryQuality || 'unknown',
    truncationEvents: (state.truncationEvents || []).slice(-10),
    contextWarnings: state.contextWarnings || 0,
    processingGuard: state.processingGuard || false,
    largeOutputCount: state.largeOutputCount || 0,
  }
}

function inflateStateFromPersist(sessionID, data) {
  const state = createOrGetState(sessionID)
  if (data.version >= 2) {
    state.recoveryState = data.recoveryState || 'idle'
    state.recoveryAttempts = data.recoveryAttempts || 0
    state.recoveryLevel = data.recoveryLevel || 0
    state.deathSpiral = data.deathSpiral || false
    state.lastRecoveryTime = data.lastRecoveryTime || 0
    state.recoveryQuality = data.recoveryQuality || 'unknown'
    state.truncationEvents = (data.truncationEvents || []).slice(-10)
    state.contextWarnings = data.contextWarnings || 0
    state.largeOutputCount = data.largeOutputCount || 0
  }
  state.toolErrorCount = data.toolErrorCount || 0
  state.toolCallCount = data.toolCallCount || 0
  state.repeatedToolCount = data.repeatedToolCount || 0
  state.exchangeCount = data.exchangeCount || 0
  state.lastToolName = data.currentTask || null
  return state
}

function persistState(sessionID, state) {
  if (debounceTimers.has(sessionID)) clearTimeout(debounceTimers.get(sessionID))

  const data = buildPersistData(sessionID, state)

  debounceTimers.set(sessionID, setTimeout(async () => {
    debounceTimers.delete(sessionID)
    const pd = _getPersistDir()
    const filePath = path.join(pd, `${state.sessionIDSafe}.json`)
    const tmpPath = filePath + '.tmp'
    try {
      await fs.promises.writeFile(tmpPath, JSON.stringify(data), 'utf8')
      await fs.promises.rename(tmpPath, filePath)
    } catch (e) {
      const logger = getLogger()
      logger.warn(`[PERSIST] write failed for ${sessionID}: ${e.message}`)
    }
  }, 5000))
}

async function immediatePersist(sessionID, state) {
  const data = buildPersistData(sessionID, state)
  const pd = _getPersistDir()
  const filePath = path.join(pd, `${state.sessionIDSafe}.json`)
  const tmpPath = filePath + '.tmp'
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(data), 'utf8')
    await fs.promises.rename(tmpPath, filePath)
  } catch (e) {
    const logger = getLogger()
    logger.warn(`[PERSIST] immediate write failed for ${sessionID}: ${e.message}`)
  }
}

function clearPersistenceDebounce(sessionID) {
  if (debounceTimers.has(sessionID)) {
    clearTimeout(debounceTimers.get(sessionID))
    debounceTimers.delete(sessionID)
  }
}

// === Task 2.3: cleanStaleFiles + loadFromPersistence + loadAllFromPersistence ===

async function cleanStaleFiles() {
  const pd = _getPersistDir()
  try {
    const files = await fs.promises.readdir(pd)
    const now = Date.now()
    const maxAge = 24 * 60 * 60 * 1000
    let cleaned = 0
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const stat = await fs.promises.stat(path.join(pd, file))
      if (now - stat.mtimeMs > maxAge) {
        await fs.promises.unlink(path.join(pd, file))
        cleaned++
      }
    }
    const logger = getLogger()
    if (cleaned > 0) logger.log(`[PERSIST] cleaned ${cleaned} stale files`)
  } catch (e) {
    const logger = getLogger()
    logger.warn(`[PERSIST] cleanup failed: ${e.message}`)
  }
}

async function loadFromPersistence(sessionID) {
  const safeID = sanitizeSessionID(sessionID)
  const pd = _getPersistDir()
  const filePath = path.join(pd, `${safeID}.json`)
  try {
    const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'))
    if (!data || !data.sessionID) return null
    return inflateStateFromPersist(sessionID, data)
  } catch (_) {
    return null
  }
}

async function loadAllFromPersistence() {
  let loaded = 0
  try {
    const pd2 = _getPersistDir()
    const files = await fs.promises.readdir(pd2)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const sessionID = file.replace(/\.json$/, '')
      const state = await loadFromPersistence(sessionID)
      if (state) loaded++
    }
    const logger = getLogger()
    if (loaded > 0) logger.log(`[PERSIST] restored ${loaded} session states from disk`)
  } catch (_) {
    // persistence directory not available
  }
  return loaded
}

module.exports = {
  createOrGetState,
  getState,
  getStatesMap,
  removeState,
  persistState,
  immediatePersist,
  buildPersistData,
  inflateStateFromPersist,
  loadFromPersistence,
  loadAllFromPersistence,
  cleanStaleFiles,
  clearPersistenceDebounce,
  get persistDir() { return _getPersistDir() },
  MAX_SESSIONS,
}
