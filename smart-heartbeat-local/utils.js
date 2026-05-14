// utils.js — Smart Heartbeat Local LLM Plugin Utilities
// 工具函數：sanitizeSessionID, context estimation, logger, timer, deepMerge, todo 讀取
//
// Exports:
//   sanitizeSessionID, estimateContextTokens, estimateProcessTime,
//   makeLogger, initLogger, getLogger,
//   setSafeTimeout, clearAllTimers, isWakeAfterSleep,
//   deepMerge, readTodos, readTodosFromPersistence

const path = require('path')
const fs = require('fs')

// === Task 1.6: sanitizeSessionID ===
function sanitizeSessionID(raw) {
  if (typeof raw !== 'string') return 'unknown'
  return raw.replace(/[^a-zA-Z0-9_\-]/g, '_')
}

// === Task 1.7: estimateContextTokens (FIX — 獨立 exchangeCount) ===
function estimateContextTokens(state, config) {
  const base = 4000
  const toolTokens = (state.toolCallHistory?.length || 0) * 1000
  const exchangeTokens = (state.exchangeCount || 0) * 500
  const total = base + toolTokens + exchangeTokens
  const capped = Math.min(total, config.effectiveMaxContext || 32000)
  state._cachedContextSize = capped
  return capped
}

function estimateProcessTime(contextSize, speedTps) {
  if (!speedTps || speedTps <= 0) return 0
  return (contextSize / speedTps) * 1000 * 1.5
}

// === Task 1.8: 三級 Logger (lazy init) ===
let _currentLogger = null

function makeLogger(level = 'warn') {
  const levels = { debug: 0, warn: 1, err: 2 }
  const current = levels[level] ?? 1
  return {
    log: (...args) => { if (current <= 0) console.log(...args) },
    warn: (...args) => { if (current <= 1) console.warn(...args) },
    err: (...args) => { if (current <= 2) console.error(...args) },
  }
}

function initLogger(level) { _currentLogger = makeLogger(level) }

function getLogger() { return _currentLogger || makeLogger('warn') }

// === Task 1.9: setSafeTimeout + macOS sleep guard + timer Set ===
const activeTimers = new Set()

function setSafeTimeout(fn, delay) {
  const scheduledAt = Date.now()
  const id = setTimeout(() => {
    activeTimers.delete(id)
    if (isWakeAfterSleep(scheduledAt + delay)) {
      const logger = getLogger()
      logger.warn(`[TIMER] wake after sleep (${Date.now() - scheduledAt - delay}ms overdue)`)
      return
    }
    try { fn() } catch (e) { const logger = getLogger(); logger.err(`[TIMER] callback error: ${e.message}`) }
  }, delay)
  activeTimers.add(id)
  return id
}

function clearAllTimers() {
  for (const id of activeTimers) clearTimeout(id)
  activeTimers.clear()
}

function isWakeAfterSleep(lastScheduledTime) {
  return Date.now() - lastScheduledTime > 30000
}

// === Task 1.10: deepMerge (簡單版，只處理 plain object) ===
function deepMerge(...objects) {
  const result = {}
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue
    for (const key of Object.keys(obj)) {
      if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
        result[key] = deepMerge(result[key] || {}, obj[key])
      } else {
        result[key] = obj[key]
      }
    }
  }
  return result
}

// === Task 1.10b: readTodos — Todo 讀取適配層 ===
async function readTodos(client, opencode, sessionID, persistDir) {
  // Priority 1: Direct API — client.session.getTodos()
  if (typeof client?.session?.getTodos === 'function') {
    try {
      const todos = await client.session.getTodos()
      if (Array.isArray(todos)) return todos
    } catch (_) { /* fall through */ }
  }

  // Priority 2: Session property — opencode.session.todos
  if (Array.isArray(opencode?.session?.todos)) {
    return opencode.session.todos
  }

  // Priority 3: Persistence fallback
  return readTodosFromPersistence(sessionID, persistDir)
}

async function readTodosFromPersistence(sessionID, persistDir) {
  if (!persistDir) return []
  const safeID = sanitizeSessionID(sessionID)
  try {
    const filePath = path.join(persistDir, `${safeID}.json`)
    const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'))
    return (data.incomplete || []).map(t => ({
      content: t.content,
      status: t.status || 'pending'
    }))
  } catch (_) {
    return []
  }
}

module.exports = {
  sanitizeSessionID,
  estimateContextTokens,
  estimateProcessTime,
  makeLogger,
  initLogger,
  getLogger,
  setSafeTimeout,
  clearAllTimers,
  isWakeAfterSleep,
  deepMerge,
  readTodos,
  readTodosFromPersistence,
  activeTimers,
}
