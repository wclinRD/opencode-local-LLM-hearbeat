// recovery.js — Recovery State Machine + Death Spiral + Tool Error Analysis
//
// Exports:
//   shouldAttemptRecovery, executeRecovery, handleRecoverySuccess,
//   handleRecoveryFailure, detectDeathSpiral, assessRecoveryQuality,
//   analyzeToolErrors, buildToolEscalationPrompt, clearRecoveryVerification
//   RECOVERY_LEVELS, getRecoveryPrompt

const { getLogger, setSafeTimeout, clearAllTimers } = require('./utils')
const { persistState } = require('./state')

// === Task 3.2: RECOVERY_LEVELS (0-3) ===
const RECOVERY_LEVELS = {
  0: () => '繼續',
  1: () => '繼續任務',
  2: (todos) => {
    const task = todos.find(t => t.status === 'in_progress') || todos[0]
    return `繼續: ${task?.content || '任務'}`
  },
  3: (todos, state, style) => buildFullRecoveryPrompt(todos, state, style),
}

function getRecoveryPrompt(level, todos, state, style) {
  const lvl = Math.min(Math.max(level || 0, 0), 3)
  const builder = RECOVERY_LEVELS[lvl]
  if (!builder) return RECOVERY_LEVELS[0]()
  return builder(todos, state, style)
}

// === Task 3.1: shouldAttemptRecovery — 7 blocking conditions ===
function shouldAttemptRecovery(state, config) {
  // 防止雙重注入
  if (state.recoveryState !== 'idle') return false
  if (state.deathSpiral) return false
  if (state.recoveryAttempts >= (config.maxRecoveryAttempts || 3)) return false
  if (state.contextWarnings >= 3) return false
  if (state.processingGuard) return false
  if (state.waitingForTool) return false
  return true
}

// === Task 3.3: executeRecovery ===
async function executeRecovery(sessionID, state, todos, client, config) {
  const prompt = getRecoveryPrompt(state.recoveryLevel, todos, state, null)

  state.recoveryState = 'injected'
  state.lastRecoveryTime = Date.now()
  state.recoveryAttempts++
  state.truncationEvents.push({ time: Date.now(), success: false })
  if (state.truncationEvents.length > 10) state.truncationEvents.shift()

  // Persist before injection
  persistState(sessionID, state)

  // Inject recovery prompt
  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: 'text', text: prompt }] },
    })
  } catch (e) {
    const logger = getLogger()
    logger.warn(`[RECOV] inject failed for ${sessionID}: ${e.message}`)
    handleRecoveryFailure(sessionID, state, config, todos, client)
    return
  }

  // Start verification
  startRecoveryVerification(sessionID, state, config, todos, client)
}

// === Task 3.4: Two-stage verification timer ===
function startRecoveryVerification(sessionID, state, config, todos, client) {
  const stage1Delay = Math.max(15000, (state.estimatedProcessTime || 30000) * 0.7)
  const stage2Delay = Math.min(stage1Delay * 2, config.recoveryVerificationMaxMs || 60000)

  clearRecoveryVerification(state)

  state.recoveryVerificationStage1 = setSafeTimeout(() => {
    const logger = getLogger()
    logger.warn(`[RECOV] processing slow (>${stage1Delay}ms) for ${sessionID}`)

    state.recoveryVerificationStage2 = setSafeTimeout(() => {
      handleRecoveryFailure(sessionID, state, config, todos, client)
    }, stage2Delay - stage1Delay)
  }, stage1Delay)
}

function clearRecoveryVerification(state) {
  if (state.recoveryVerificationStage1) {
    clearTimeout(state.recoveryVerificationStage1)
    state.recoveryVerificationStage1 = null
  }
  if (state.recoveryVerificationStage2) {
    clearTimeout(state.recoveryVerificationStage2)
    state.recoveryVerificationStage2 = null
  }
}

// === Task 3.5: handleRecoverySuccess + handleRecoveryFailure ===
function handleRecoverySuccess(state, toolEvent) {
  clearRecoveryVerification(state)
  state.recoveryState = 'verified'
  state.recoveryQuality = 'unknown'
  state.recoveryLevel = 0

  const last = state.truncationEvents[state.truncationEvents.length - 1]
  if (last) last.success = true

  assessRecoveryQuality(state, toolEvent)
}

function handleRecoveryFailure(sessionID, state, config, todos, client) {
  clearRecoveryVerification(state)
  state.recoveryState = 'failed'

  const last = state.truncationEvents[state.truncationEvents.length - 1]
  if (last) last.success = false

  // Death spiral check
  if (detectDeathSpiral(state, config)) {
    state.deathSpiral = true
    state.recoveryState = 'stopped'
    const logger = getLogger()
    logger.warn(`[RECOV] death spiral detected for ${sessionID}, recovery stopped`)
    autoNotifyCore(state, sessionID)
    return
  }

  // Retry with escalation
  if (state.recoveryAttempts < (config.maxRecoveryAttempts || 3)) {
    state.recoveryLevel = Math.min(state.recoveryLevel + 1, 3)
    executeRecovery(sessionID, state, todos, client, config)
  } else {
    state.recoveryState = 'stopped'
    const logger = getLogger()
    logger.warn(`[RECOV] max attempts (${config.maxRecoveryAttempts}) reached for ${sessionID}`)
    autoNotifyCore(state, sessionID)
  }
}

// === Task 3.5: assessRecoveryQuality ===
function assessRecoveryQuality(state, toolEvent) {
  const toolName = toolEvent.properties?.name || 'unknown'

  // If the first tool after recovery is the same as the last tool before truncation → confused
  if (state.lastToolBeforeTruncation && toolName === state.lastToolBeforeTruncation) {
    state.recoveryQuality = 'confused'
    return { quality: 'confused' }
  }

  state.recoveryQuality = 'good'
  return { quality: 'good' }
}

// === Task 3.6: detectDeathSpiral — 5 methods ===
function detectDeathSpiral(state, config) {
  const now = Date.now()
  const windowStart = now - (config.deathSpiralWindowMs || 300000)
  const recentEvents = state.truncationEvents.filter(e => e.time >= windowStart)

  // Method 1: Frequency — 3+ truncations in window
  if (recentEvents.length >= (config.deathSpiralThreshold || 3)) return true
  // Method 2: Consecutive failures — 2+ failed recoveries
  if (recentEvents.filter(e => e.success === false).length >= 2) return true
  // Method 3: Context pressure + truncation
  if (state.contextWarnings >= 3 && recentEvents.length >= 1) return true
  // Method 4: Tool error spiral
  if (state.toolErrorAnalysis?.level >= 3 && recentEvents.length >= 1) return true
  // Method 5: Same tool cascade
  if (state.toolErrorAnalysis?.consecutiveSameTool && state.toolErrorAnalysis?.errorCount >= 5) return true

  return false
}

// === Task 3.7: analyzeToolErrors — 4-level pattern analyzer ===
function analyzeToolErrors(state, config) {
  const history = state.toolCallHistory || []
  const recent = history.slice(-10)
  const recentErrors = recent.filter(t => t.status === 'error')
  const errorCount = recentErrors.length

  if (errorCount === 0) return { level: 0, pattern: 'none', toolType: null, errorCount: 0, consecutiveSameTool: false, lastErrorTool: null }

  const errorToolNames = [...new Set(recentErrors.map(t => t.name))]
  const lastTool = history[history.length - 1]
  const consecutiveSameTool = lastTool && lastTool.status === 'error' &&
    history.slice(-Math.min(errorCount, 10)).every(t => t.status === 'error' && t.name === lastTool.name)

  let level = 0
  if (errorCount >= 7) level = 4       // search web
  else if (errorCount >= 4) level = 3  // tool-type aware
  else if (errorCount >= 2) level = 2  // change method
  else if (errorCount >= 1) level = 1  // retry

  return {
    level, pattern: errorToolNames.length === 1 ? 'single_tool' : 'multi_tool',
    toolType: errorToolNames.length === 1 ? errorToolNames[0] : 'mixed',
    errorCount, consecutiveSameTool, lastErrorTool: lastTool?.name || null,
  }
}

// === Task 3.8: buildToolEscalationPrompt ===
function buildToolEscalationPrompt(analysis, task, state) {
  const { level, toolType, errorCount } = analysis
  if (level <= 1) return `[續行] tool 失敗。重試任務「${task}」，直接執行。`
  if (level <= 3) {
    switch (toolType) {
      case 'bash': return `[續行] bash 失敗 ${errorCount} 次。改用不同指令或 write 腳本。`
      case 'edit': return `[續行] edit 失敗 ${errorCount} 次。先用 read 確認內容再 edit。`
      case 'write': return `[續行] write 失敗 ${errorCount} 次。確認目錄存在後再 write。`
      default: return `[續行] ${toolType} 失敗 ${errorCount} 次。換完全不同方法。`
    }
  }
  return `[續行] tool 持續失敗 ${errorCount} 次。先用 websearch 搜尋正確做法。不要猜。`
}

// === buildFullRecoveryPrompt — Level 3 完整復原 ===
function buildFullRecoveryPrompt(todos, state, promptStyle) {
  const pending = todos.filter(t => t.status !== 'completed')
  const taskList = pending.map((t, i) => `${i + 1}. ${t.content} (${t.status === 'in_progress' ? '進行中' : t.status || '待處理'})`).join('\n')
  const nextTask = pending.find(t => t.status === 'in_progress') || pending[0]

  return [
    `上下文已重置。`,
    ``,
    `未完成任務：`,
    `${taskList}`,
    ``,
    `從「${nextTask?.content || '任務'}」繼續。先讀取相關檔案，再繼續完成。不要從頭開始。`,
    `直接執行，完成後用 todowrite。不要問問題。`,
  ].join('\n')
}

// === autoNotifyCore — 內部通知，不依賴 opencodeRef ===
function autoNotifyCore(state, sessionID) {
  const logger = getLogger()
  const triggers = []
  if (state.deathSpiral) triggers.push('死亡螺旋偵測，復原已停止')
  if (state.recoveryState === 'stopped') triggers.push('復原已達上限，等待使用者介入')
  if (state.toolErrorCount >= 8) triggers.push(`tool 錯誤 ${state.toolErrorCount} 次`)
  if (triggers.length === 0) return
  logger.warn(`[NOTIFY] [${sessionID}] ${triggers.join('; ')}`)
}

module.exports = {
  shouldAttemptRecovery,
  executeRecovery,
  handleRecoverySuccess,
  handleRecoveryFailure,
  detectDeathSpiral,
  assessRecoveryQuality,
  analyzeToolErrors,
  buildToolEscalationPrompt,
  clearRecoveryVerification,
  getRecoveryPrompt,
  RECOVERY_LEVELS,
  buildFullRecoveryPrompt,
}
