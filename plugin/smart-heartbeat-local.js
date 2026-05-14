// smart-heartbeat-local.js — V1 Adapter for Modular smart-heartbeat-local
// Imports CJS modular modules, wraps in V1 { id, server } format.
// OpenCode loads this via opencode.json's "smart-heartbeat-local" entry.

const {
  DEFAULT_CONFIG, validateConfig, detectModelProfile,
} = require('./smart-heartbeat-local/config')
const {
  initLogger, getLogger, setSafeTimeout, clearAllTimers,
  readTodos, isWakeAfterSleep,
} = require('./smart-heartbeat-local/utils')
const {
  createOrGetState, getState, persistState, removeState,
  loadAllFromPersistence, cleanStaleFiles, clearPersistenceDebounce,
} = require('./smart-heartbeat-local/state')
const {
  handleToolStarted, handleToolCompleted, handleToolError,
  handleMessageCompleted, checkStuckState,
} = require('./smart-heartbeat-local/monitor')
const {
  injectContinuation,
} = require('./smart-heartbeat-local/injector')
const {
  shouldAttemptRecovery, executeRecovery, handleRecoverySuccess,
  clearRecoveryVerification,
} = require('./smart-heartbeat-local/recovery')

// === Plugin Definition ===
const plugin = {
  id: 'smart-heartbeat-local',

  server: async (input, config = {}) => {
    const { client } = input

    // Merge: V1 config overrides DEFAULT_CONFIG (no loadConfig since V1 has no opencode.config.heartbeat)
    const mergedConfig = { ...DEFAULT_CONFIG, ...config }
    initLogger(mergedConfig.logLevel || 'warn')
    const logger = getLogger()

    // Validate merged config — warn but don't block
    const { errors: configErrors } = validateConfig(mergedConfig)
    for (const e of configErrors) logger.warn(`[CONFIG] ${e}`)

    // === Per-session adapter state (NOT in modular state.js) ===
    const pendingInjects = new Map()         // sessionID → setTimeout ID
    const commandHandledTimestamps = new Map() // sessionID → timestamp
    const consecutiveFailures = new Map()    // sessionID → count

    function cancelPendingInject(sessionID) {
      if (pendingInjects.has(sessionID)) {
        clearTimeout(pendingInjects.get(sessionID))
        pendingInjects.delete(sessionID)
      }
    }

    function scheduleInjectCheck(sessionID, delayMs) {
      cancelPendingInject(sessionID)
      pendingInjects.set(sessionID, setTimeout(async () => {
        pendingInjects.delete(sessionID)
        try {
          await checkAndInject(sessionID)
        } catch (e) {
          logger.err(`[INJECT] checkAndInject error for ${sessionID}: ${e.message}`)
        }
      }, delayMs))
    }

    // === Helpers ===

    function getSessionID(event) {
      return event.properties?.sessionID || event.info?.sessionID || event.sessionID
    }

    function getUserMessageText(event) {
      const props = event.properties || {}
      const info = props.info || {}
      return info?.text || props?.text
        || (Array.isArray(props?.parts) ? props.parts.map(p => p.text || '').join('') : null)
        || (Array.isArray(info?.parts) ? info.parts.map(p => p.text || '').join('') : null)
        || (props?.message?.text ?? null)
    }

    async function getTodos(sessionID) {
      try {
        const resp = await client.session.todo({ path: { id: sessionID } })
        return resp?.data ?? []
      } catch (e) {
        return []
      }
    }

    function getIncomplete(todos) {
      if (!Array.isArray(todos)) return []
      return todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled')
    }

    // === checkAndInject — main injection decision loop ===
    async function checkAndInject(sessionID) {
      const state = getState(sessionID)
      if (!state) return

      // Skip if disabled
      if (state.heartbeatDisabled) return

      // Skip if user intervention cooldown active
      if (state.heartbeatCooldownUntil && Date.now() < state.heartbeatCooldownUntil) return

      // Check consecutive failures
      const fails = consecutiveFailures.get(sessionID) || 0
      if (fails >= 5) return

      // Processing guard: allow timeout release
      if (state.processingGuard) {
        const guardAge = Date.now() - (state.lastInjectionTime || 0)
        if (guardAge > Math.max(mergedConfig.countdownSeconds * 1000 * 2, 120000)) {
          logger.warn(`[GUARD] force-release stale guard after ${guardAge}ms for ${sessionID}`)
          state.processingGuard = false
        } else {
          return
        }
      }

      // In-flight tool check
      if (state.waitingForTool) {
        if (state.inFlightTool && Date.now() - state.inFlightTool.startTime > state.inFlightTool.timeout) {
          logger.warn(`[INJECT] in-flight tool ${state.inFlightTool.name} timed out for ${sessionID}`)
          state.waitingForTool = false
          state.inFlightTool = null
        } else {
          return
        }
      }

      // Min interval check
      if (state.lastInjectionTime && Date.now() - state.lastInjectionTime < mergedConfig.minIntervalMs) return

      // Read todos
      const todos = await getTodos(sessionID)
      if (!todos?.length) return
      const incomplete = getIncomplete(todos)
      if (!incomplete.length) return

      // Check recovery state machine
      if (state.recoveryState !== 'idle') {
        if (shouldAttemptRecovery(state, mergedConfig)) {
          await executeRecovery(sessionID, state, todos, client, mergedConfig)
        }
        return
      }

      // Normal continuation
      await injectContinuation(sessionID, state, todos, client, mergedConfig)
    }

    // === Handle user intervention (reset recovery state) ===
    function handleUserIntervention(state) {
      clearRecoveryVerification(state)
      state.recoveryState = 'idle'
      state.recoveryLevel = 0
      state.recoveryAttempts = 0
      state.deathSpiral = false
      state.truncationEvents = []
      state.toolErrorCount = 0
      state.toolErrorAnalysis = { level: 0, pattern: 'none', toolType: null, errorCount: 0, consecutiveSameTool: false, lastErrorTool: null }
      state.consecutiveFailures = 0
      state.stuckCount = 0
    }

    // === Build status summary ===
    function buildStatusSummary(state, sessionID) {
      return [
        `Session: ${sessionID}`,
        `Enabled: ${!state.heartbeatDisabled}`,
        `Intervention: ${state.interventionState || 'none'} (${state.userInterventionCount || 0} times)`,
        `Recovery: ${state.recoveryState} (${state.recoveryAttempts || 0} attempts)`,
        `Death spiral: ${state.deathSpiral}`,
        `Tool errors: ${state.toolErrorCount} (level ${state.toolErrorAnalysis?.level || 0})`,
        `Context warnings: ${state.contextWarnings}`,
        `Processing guard: ${state.processingGuard}`,
        `Cooldown: ${state.heartbeatCooldownUntil > Date.now() ? Math.ceil((state.heartbeatCooldownUntil - Date.now()) / 1000) + 's' : 'none'}`,
      ].join('\n')
    }

    // === Startup: restore states from persistence ===
    try {
      await loadAllFromPersistence()
      cleanStaleFiles()
    } catch (_) {}

    // === Return V1 Hooks ===
    return {
      // Event hook: receive all OpenCode events
      event: async ({ event }) => {
        try {
          const sid = getSessionID(event)
          if (!sid) return

          // Ensure state exists
          let state = getState(sid)
          if (!state) {
            createOrGetState(sid)
            state = getState(sid)
          }

          // --- Tool events → modular handlers ---
          if (event.type === 'tool.started' || event.type === 'tool.executing' || event.type === 'tool.running') {
            handleToolStarted(state, event, mergedConfig)
            cancelPendingInject(sid)
            return
          }

          if (event.type === 'tool.completed') {
            handleToolCompleted(state, event)

            // Persist on important tools
            const toolName = event.properties?.name || ''
            if (toolName === 'todowrite' || toolName === 'edit' || toolName === 'write') {
              persistState(sid, state)
            }

            // Schedule injection check (short debounce)
            scheduleInjectCheck(sid, 500)
            return
          }

          if (event.type === 'tool.error') {
            handleToolError(state, event)

            // Track consecutive failures
            const fails = (consecutiveFailures.get(sid) || 0) + 1
            consecutiveFailures.set(sid, fails)

            logger.warn(`[TOOL] error #${state.toolErrorCount} for ${sid}: ${event.properties?.error || event.properties?.message || ''}`)

            if (state.toolErrorCount >= mergedConfig.maxToolErrors) {
              state.heartbeatDisabled = true
              cancelPendingInject(sid)
              logger.warn(`[TOOL] max errors (${mergedConfig.maxToolErrors}) reached, disabling heartbeat for ${sid}`)
            }
            return
          }

          // --- message.updated → handle user/assistant messages ---
          if (event.type === 'message.updated') {
            const info = event.properties?.info || {}
            const role = info.role
            const msgText = getUserMessageText(event)

            if (role === 'user') {
              cancelPendingInject(sid)

              // Parse /heartbeat commands
              if (msgText) {
                const trimmed = msgText.trim().toLowerCase()
                if (trimmed.startsWith('/heartbeat')) {
                  // Prevent double-handling (command hook gets priority)
                  const cmdTs = commandHandledTimestamps.get(sid)
                  if (cmdTs && Date.now() - cmdTs < 3000) return

                  const arg = trimmed.replace(/^\/heartbeat\s*/, '').trim()
                  if (arg === 'off' || arg === '0' || arg === 'false') {
                    state.heartbeatDisabled = true
                    try { await client.tui.showToast({ body: { message: 'Heartbeat 已關閉', variant: 'info' } }) } catch (_) {}
                    return
                  }
                  if (arg === 'on' || arg === '1' || arg === 'true' || arg === '') {
                    state.heartbeatDisabled = false
                    consecutiveFailures.set(sid, 0)
                    handleUserIntervention(state)
                    try { await client.tui.showToast({ body: { message: 'Heartbeat 已開啟', variant: 'success' } }) } catch (_) {}
                    return
                  }
                  if (arg === 'status') {
                    try { await client.tui.showToast({ body: { message: `Heartbeat 狀態: ${!state.heartbeatDisabled ? '開啟' : '關閉'}`, variant: 'info' } }) } catch (_) {}
                    return
                  }
                  return
                }
              }

              // User intervention: reset recovery state, start cooldown
              handleUserIntervention(state)
              state.heartbeatCooldownUntil = Date.now() + 60000
              state.interventionState = 'user_active'
              state.userLastActiveTime = Date.now()
              state.userInterventionCount = (state.userInterventionCount || 0) + 1
              consecutiveFailures.set(sid, 0)

            } else if (role === 'assistant') {
              // Assistant message → schedule injection check with debounce
              if (state.heartbeatDisabled) return
              if (state.heartbeatCooldownUntil && Date.now() < state.heartbeatCooldownUntil) return
              scheduleInjectCheck(sid, 3000)
            }
            return
          }

          // --- session.idle → schedule injection check ---
          if (event.type === 'session.idle') {
            if (state.heartbeatDisabled) return
            if (state.heartbeatCooldownUntil && Date.now() < state.heartbeatCooldownUntil) return
            scheduleInjectCheck(sid, 1500)
            return
          }

          // --- session.error / session.aborted → cleanup ---
          if (event.type === 'session.error' || event.type === 'session.aborted') {
            cancelPendingInject(sid)
            return
          }

          // --- session.deleted → full cleanup ---
          if (event.type === 'session.deleted') {
            cancelPendingInject(sid)
            commandHandledTimestamps.delete(sid)
            consecutiveFailures.delete(sid)
            removeState(sid)
            return
          }

        } catch (e) {
          logger.err(`[EVENT] handler crash: ${e.message}`)
        }
      },

      // Command hook: /heartbeat on|off|status|disable|enable
      'command.execute.before': async (input, output) => {
        if (input.command === '/heartbeat') {
          const sid = input.sessionID
          const arg = (input.arguments || '').trim().toLowerCase()

          // Ensure state
          let state = getState(sid)
          if (!state) { createOrGetState(sid); state = getState(sid) }

          // Mark handled to prevent event hook double-handling
          commandHandledTimestamps.set(sid, Date.now())

          if (arg === 'off' || arg === '0' || arg === 'false') {
            state.heartbeatDisabled = true
            cancelPendingInject(sid)
            try { await client.tui.showToast({ body: { message: 'Heartbeat 已關閉', variant: 'info' } }) } catch (_) {}
            output.parts = [{ type: 'text', text: '[Heartbeat 已關閉]' }]

          } else if (arg === 'on' || arg === '1' || arg === 'true' || arg === '') {
            state.heartbeatDisabled = false
            consecutiveFailures.set(sid, 0)
            handleUserIntervention(state)
            try { await client.tui.showToast({ body: { message: 'Heartbeat 已開啟', variant: 'success' } }) } catch (_) {}
            output.parts = [{ type: 'text', text: '[Heartbeat 已開啟]' }]

          } else if (arg === 'status') {
            const summary = buildStatusSummary(state, sid)
            output.parts = [{ type: 'text', text: summary }]

          } else if (arg === 'disable') {
            state.heartbeatDisabled = true
            cancelPendingInject(sid)
            try { await client.tui.showToast({ body: { message: 'Heartbeat 已永久關閉', variant: 'info' } }) } catch (_) {}
            output.parts = [{ type: 'text', text: '[Heartbeat 已永久關閉]' }]

          } else if (arg === 'enable' || arg === '繼續') {
            state.heartbeatDisabled = false
            state.heartbeatCooldownUntil = 0
            state.interventionState = 'none'
            consecutiveFailures.set(sid, 0)
            try { await client.tui.showToast({ body: { message: 'Heartbeat 已啟用，將自動續行', variant: 'success' } }) } catch (_) {}
            output.parts = [{ type: 'text', text: '[Heartbeat 已啟用，將自動續行]' }]

          } else {
            try { await client.tui.showToast({ body: { message: `未知參數: ${arg}。用 on|off|status|disable|enable`, variant: 'warning' } }) } catch (_) {}
            output.parts = [{ type: 'text', text: `未知參數: ${arg}。用 /heartbeat on|off|status|disable|enable` }]
          }
        }
      },
    }
  },
}

module.exports = plugin
module.exports.server = plugin.server
