// smart-heartbeat-local.js — V1 Adapter for Modular smart-heartbeat-local
// Imports CJS modular modules, wraps in V1 { id, server } format.
// OpenCode loads this via opencode.json's "smart-heartbeat-local" entry.

const {
  DEFAULT_CONFIG, validateConfig, detectModelProfile,
} = require('./smart-heartbeat-local/config')
const {
  initLogger, getLogger, setSafeTimeout, clearAllTimers,
  readTodos, readTodosFromPersistence, isWakeAfterSleep,
} = require('./smart-heartbeat-local/utils')
const {
  createOrGetState, getState, getStatesMap, persistState, removeState,
  loadAllFromPersistence, cleanStaleFiles, clearPersistenceDebounce, persistDir,
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

      // Priority 1: OpenCode V1 API (current approach)
      try {
        const resp = await client.session.todo({ path: { id: sessionID } })
        if (resp?.data && Array.isArray(resp.data) && resp.data.length > 0) {
          try { await client.tui.showToast({ body: { message: `P1獲得${resp.data.length}個todos`, variant: 'info' } }) } catch (_) {}
          return resp.data
        }
      } catch (e) {
        try { await client.tui.showToast({ body: { message: `P1失敗: ${e.message.slice(0,50)}`, variant: 'warning' } }) } catch (_) {}
      }

      // Priority 2: OpenCode V2 API (client.session.getTodos)
      try {
        if (typeof client?.session?.getTodos === 'function') {
          const todos = await client.session.getTodos()
          if (Array.isArray(todos) && todos.length > 0) {
            try { await client.tui.showToast({ body: { message: `P2獲得${todos.length}個todos`, variant: 'info' } }) } catch (_) {}
            return todos
          }
        }
      } catch (e) {
        try { await client.tui.showToast({ body: { message: `P2失敗: ${e.message.slice(0,50)}`, variant: 'warning' } }) } catch (_) {}
      }

      // Priority 3: Session property fallback
      try {
        if (typeof client?.session?.todos !== 'undefined') {
          const todos = client.session.todos
          if (Array.isArray(todos) && todos.length > 0) {
            try { await client.tui.showToast({ body: { message: `P3獲得${todos.length}個todos`, variant: 'info' } }) } catch (_) {}
            return todos
          }
        }
      } catch (e) {
        try { await client.tui.showToast({ body: { message: `P3失敗: ${e.message.slice(0,50)}`, variant: 'warning' } }) } catch (_) {}
      }

      // Priority 4: Cached from todowrite tool results
      try {
        const state = getState(sessionID)
        if (state && state._cachedTodos && state._cachedTodos.length > 0) {
          const recent = Date.now() - state._cachedTodosUpdated < 3600000 // 1hr cache
          if (recent) {
            const incomplete = state._cachedTodos.filter(
              t => t.status !== 'completed' && t.status !== 'cancelled'
            )
            if (incomplete.length > 0) {
              try { await client.tui.showToast({ body: { message: `P4快取${incomplete.length}個未完成todos`, variant: 'info' } }) } catch (_) {}
              return incomplete
            }
          }
        }
      } catch (e) {
        try { await client.tui.showToast({ body: { message: `P4快取失敗: ${e.message.slice(0,50)}`, variant: 'warning' } }) } catch (_) {}
      }

      // Priority 5: Persistence fallback
      try {
        const pd = typeof persistDir === 'string' ? persistDir : '.opencode/heartbeat-state/'
        const fromDisk = await readTodosFromPersistence(sessionID, pd)
        if (fromDisk.length > 0) {
          const incomplete = fromDisk.filter(
            t => t.status !== 'completed' && t.status !== 'cancelled'
          )
          if (incomplete.length > 0) {
            try { await client.tui.showToast({ body: { message: `P5磁碟${incomplete.length}個未完成todos`, variant: 'info' } }) } catch (_) {}
            return incomplete
          }
        }
      } catch (e) {
        try { await client.tui.showToast({ body: { message: `P5磁碟失敗: ${e.message.slice(0,50)}`, variant: 'warning' } }) } catch (_) {}
      }

      try { await client.tui.showToast({ body: { message: `[TODO] ALL優先級空: ${sessionID.slice(0,12)}...`, variant: 'warning' } }) } catch (_) {}
      return []
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

      // Processing guard: allow timeout release (shorter 30s min)
      if (state.processingGuard) {
        const guardAge = Date.now() - (state.lastInjectionTime || 0)
        const guardTimeout = Math.max(mergedConfig.countdownSeconds * 1000, 30000)
        if (guardAge > guardTimeout) {
          try { await client.tui.showToast({ body: { message: `[GUARD] force-release stale guard after ${Math.round(guardAge/1000)}s`, variant: 'warn' } }) } catch (_) {}
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

    // === Periodic heartbeat timer (critical for local LLM) ===
    // V1 plugins rely on events. If no events fire (session.idle may not fire in local LLM),
    // heartbeat never triggers. This timer provides a safety net.
    const heartbeatTimer = setInterval(async () => {
      try {
        for (const [sid] of getStatesMap()) {
          await checkAndInject(sid).catch(e => {
            logger.warn(`[TIMER] checkAndInject error for ${sid}: ${e.message}`)
          })
        }
      } catch (e) {
        logger.err(`[TIMER] interval error: ${e.message}`)
      }
    }, mergedConfig.countdownSeconds * 1000)

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
            const toolName = event.properties?.name || ''

            // Cache todos from todowrite results (P4 fallback for getTodos)
            if (toolName === 'todowrite') {
              const output = event.properties?.output || event.properties?.result || event.properties?.arguments
              if (output) {
                try {
                  const parsed = typeof output === 'string' ? JSON.parse(output) : output
                  const todos = Array.isArray(parsed) ? parsed
                    : parsed?.todos ? parsed.todos
                    : null
                  if (todos && Array.isArray(todos) && todos.length > 0) {
                    state._cachedTodos = todos.map(t => ({
                      content: t.content || t.name || '',
                      status: t.status || 'pending'
                    }))
                    state._cachedTodosUpdated = Date.now()
                  }
                } catch (_) { /* parse failed, skip cache */ }
              }
            }

            // Persist on important tools
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

              // User intervention: reset recovery state, start dynamic cooldown
              handleUserIntervention(state)
              state.userLastActiveTime = Date.now()
              state.userInterventionCount = (state.userInterventionCount || 0) + 1

              // Dynamic cooldown: 30s → 60s → 120s, reset after 5 min idle
              state.cooldownLevel = (state.cooldownLevel || 0) + 1
              const fiveMinAgo = Date.now() - 5 * 60 * 1000
              if (!state._lastUserMessageTime || state._lastUserMessageTime < fiveMinAgo) {
                state.cooldownLevel = 1
              }
              state._lastUserMessageTime = Date.now()
              const cooldownMs = Math.min(30000 * Math.pow(2, state.cooldownLevel - 1), 120000)
              state.heartbeatCooldownUntil = Date.now() + cooldownMs
              state.interventionState = 'user_active'
              consecutiveFailures.set(sid, 0)

            } else if (role === 'assistant') {
              // Assistant message → schedule injection check with debounce
              // NOTE: cooldown check is inside checkAndInject, not here
              if (state.heartbeatDisabled) return
              scheduleInjectCheck(sid, 3000)
            }
            return
          }

            // --- session.idle → schedule injection check ---
          if (event.type === 'session.idle') {
            // NOTE: cooldown check is inside checkAndInject, not here
            if (state.heartbeatDisabled) return
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
