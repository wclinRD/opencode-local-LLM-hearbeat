// monitor.js — Tool Monitoring + Context Pressure + Stuck + Truncation Detection
//
// Exports:
//   handleToolStarted, handleToolCompleted, handleToolError,
//   handleMessageCompleted, checkStuckState, updateContextPressure,
//   detectTruncation

// === Task 2.4: handleToolStarted ===
function handleToolStarted(state, event, config) {
  state.lastActivity = Date.now()

  const toolName = event.properties?.name || event.properties?.tool || 'unknown'

  // Track same-tool repetition
  if (state.lastToolName === toolName) {
    state.repeatedToolCount++
  } else {
    state.repeatedToolCount = 0
  }

  // In-flight tracking — 優先使用 config.toolTimeout
  const timeoutsMs = config?.toolTimeout
    ? Object.fromEntries(Object.entries(config.toolTimeout).map(([k, v]) => [k, v * 1000]))
    : { task: 300000, bash: 120000, edit: 60000, read: 30000, default: 60000 }
  const timeout = timeoutsMs[toolName] || timeoutsMs.default || 60000
  state.inFlightTool = { name: toolName, startTime: Date.now(), timeout }
  if (toolName === 'task') state.waitingForTool = true

  state.lastToolName = toolName
  state.lastToolTime = Date.now()
  state.toolCallCount++
}

// === Task 2.5: handleToolCompleted ===
function handleToolCompleted(state, event) {
  state.lastActivity = Date.now()
  const toolName = event.properties?.name || 'unknown'
  state.toolCallHistory.push({ name: toolName, time: Date.now(), status: 'ok' })
  if (state.toolCallHistory.length > 20) state.toolCallHistory.shift()

  // Reset error count on success
  state.toolErrorCount = 0

  // Release in-flight if matching tool
  if (state.inFlightTool?.name === toolName) {
    state.inFlightTool = null
    state.waitingForTool = false
  }

  // Invalidate context cache
  state._cachedContextSize = undefined
}

// === Task 2.5: handleToolError ===
function handleToolError(state, event) {
  state.lastActivity = Date.now()
  const toolName = event.properties?.name || 'unknown'
  state.toolErrorCount++
  state.toolErrorsByTool[toolName] = (state.toolErrorsByTool[toolName] || 0) + 1
  state.toolCallHistory.push({ name: toolName, time: Date.now(), status: 'error' })
  if (state.toolCallHistory.length > 20) state.toolCallHistory.shift()
  state.lastToolTime = Date.now()

  // Release in-flight if matching
  if (state.inFlightTool?.name === toolName) {
    state.inFlightTool = null
    state.waitingForTool = false
  }
}

// === Task 2.6: handleMessageCompleted (FIX: exchangeCount independent) ===
function handleMessageCompleted(state, event) {
  const role = event.info?.role || event.properties?.role
  if (role === 'user') {
    state.exchangeCount++
  }
}

// === Task 2.7: updateContextPressure ===
function updateContextPressure(state, toolOutputSize) {
  if (toolOutputSize > 2000) state.largeOutputCount++
  if (state.largeOutputCount >= 3) {
    state.contextWarnings++
    state.largeOutputCount = 0
  }
}

// === Task 2.8: checkStuckState ===
function checkStuckState(state, todos, config) {
  const toolLoop = state.repeatedToolCount >= (config.maxRepeatedTool || 10)
  const toolErrors = state.toolErrorCount >= (config.maxToolErrors || 8)
  const noActivity = state.lastToolTime && (Date.now() - state.lastToolTime > (config.maxIdleSeconds || 120) * 1000)
  const signal = { stuck: false, reason: null, detail: null }

  if (toolLoop) return { stuck: true, reason: 'tool_loop', detail: `${state.lastToolName} x${state.repeatedToolCount}` }
  if (toolErrors) return { stuck: true, reason: 'tool_errors', detail: `${state.toolErrorCount} consecutive errors` }
  if (noActivity) return { stuck: true, reason: 'idle', detail: `no activity for ${config.maxIdleSeconds}s` }

  return signal
}

// === Task 2.9: detectTruncation — 3 methods ===
function detectTruncation(state, previousTodos, currentTodos, config) {
  const result = { truncated: false, method: null, confidence: 0 }

  // Method 1: Todo state regression
  if (previousTodos && currentTodos && previousTodos.length > 0) {
    const hadProgress = previousTodos.some(t => t.status === 'in_progress' || t.status === 'resumed')
    const allPending = currentTodos.every(t => t.status !== 'in_progress' && t.status !== 'resumed')
    if (hadProgress && allPending) {
      result.truncated = true
      result.method = 'todo_regression'
      result.confidence = 0.8
      return result
    }
  }

  // Method 2: Repeated tool calls after gap
  const history = state.toolCallHistory || []
  if (history.length >= 4) {
    const recent = history.slice(-3)
    const older = history.slice(-6, -3)
    if (older.length === 3 && recent.length === 3) {
      const matchAll = recent.every((t, i) => t.name === older[i]?.name)
      if (matchAll && recent.filter(t => t.status === 'ok').length === 3) {
        result.truncated = true
        result.method = 'repeated_calls'
        result.confidence = 0.6
        return result
      }
    }
  }

  // Method 3: Unexplained context size drop
  if (state._cachedContextSize !== undefined && state._previousContextSize !== undefined) {
    const drop = state._previousContextSize - state._cachedContextSize
    if (drop > 3000) {
      result.truncated = true
      result.method = 'context_drop'
      result.confidence = 0.7
      return result
    }
  }
  state._previousContextSize = state._cachedContextSize

  return result
}

module.exports = {
  handleToolStarted,
  handleToolCompleted,
  handleToolError,
  handleMessageCompleted,
  checkStuckState,
  updateContextPressure,
  detectTruncation,
}
