# Phase 4 — UX & Integration

**目標：** 完成 index.js（事件路由 + lifecycle + 注入排程）、使用者緊急介入系統、營運可觀測性、macOS 睡眠喚醒保護。

**前置條件：** Gate #3 通過（recovery.js, injector.js 就緒，狀態機正確）

**設計參考：** `2026-05-13-heartbeat-local-llm.md` §使用者介入系統、§Plugin Lifecycle、§macOS 睡眠喚醒處理、§Log 策略

---

## TODO 列表

LLM 實作時依序執行，每完成一項用 `todowrite` 設為 completed：

| # | 任務 | 檔案 | 行數估計 | 類型 |
|---|------|------|---------|------|
| 4.1 | `onStart` — crash handler install / config load / persistence dir / event registration / startup log | index.js | ~45 | 生命週期 |
| 4.2 | `onStop` — crash handler remove / handler unregister / safeOnStop (clearTimers→persistAll→cleanup) | index.js | ~30 | 生命週期 |
| 4.3 | `shouldSkipInjection` + `handlePluginCrash` — heartbeatDisabled check / intervention auto-resume / crash cleanup | index.js | ~30 | 安全 |
| 4.4 | `handleUserMessage` — full counter reset / 60s cooldown / /heartbeat disable|enable|status 命令解析 | index.js | ~50 | UX |
| 4.5 | `showStatusToUser` + `autoNotify` + `buildStatusSummary` — toast fallback / 3 trigger conditions / status string | index.js | ~40 | UX |
| 4.6 | `checkAndInject` — injection decision loop / cooldown / processing guard / in-flight timeout / todo reading / **recovery verification on tool.started** (moved from Phase 2 to avoid circular dep) | index.js | ~50 | 流程 |
| 4.7 | `phase4-intervention.test.js` — 6 cases (reset×1 / cooldown×1 / auto-resume×1 / disable×1 / enable×1 / status×1) | test/ | ~40 | 測試 |
| 4.8 | `phase4-integration.test.js` — 4 cases (onStart crash handler / onStop cleanup / safeOnStop timeout / handlers wiring) | test/ | ~40 | 測試 |
| 4.9 | **Gate #4 驗證** — plugin 載入不 crash / onStop 清理 / /heartbeat status / cooldown / auto-resume / crash handler | — | — | 檢查點 |

**實作順序：** 4.1→4.2→4.3→4.4→4.5→4.6→4.7→4.8→4.9

---

## 檔案架構

```
.opencode/plugins/smart-heartbeat-local/
├── index.js          # Complete: lifecycle + event router + injection loop (WRITE)
└── .opencode/opencode.json  # Register plugin (MODIFY)
```

## Module: index.js (complete)

**最終負責：**
- `onStart(opencode, client)` — 啟動
- `onStop()` — 關閉
- Event dispatching（from Phase 2 的 event handlers）
- Injection decision loop（定時檢查是否要 inject）
- User intervention handling（/heartbeat commands）
- Notifications (autoNotify)

### 實作任務

**Task 4.1: Plugin lifecycle — onStart**

```javascript
let opencodeRef = null
let clientRef = null
let activeConfig = null  // set by onStart, used by checkAndInject / shouldSkipInjection
let eventHandlers = []
let log

// 通用 event → sessionID 提取器 (兼容多種 payload 格式)
function getSessionID(event) {
  return event.properties?.sessionID || event.info?.sessionID || event.sessionID
}

module.exports = {
  onStart: async (opencode, client) => {
    opencodeRef = opencode
    clientRef = client
    
    // Load config first (needed for logger)
    const { config, errors } = loadConfig(opencode)
    activeConfig = config
    log = makeLogger(config.logLevel)
    if (errors.length > 0) {
      for (const e of errors) warn(`[CONFIG] ${e}`)
    }
    
    // Safety: clean orphaned timers
    if (activeTimers.size > 0) {
      warn(`[STARTUP] ${activeTimers.size} orphaned timers, cleaning up`)
      clearAllTimers()
    }
    
    // Install crash handlers (after logger ready)
    process.on('uncaughtException', handlePluginCrash)
    process.on('unhandledRejection', handlePluginCrash)
    
    // Setup persistence directory (with fallback)
    try {
      await fs.promises.mkdir(persistDir, { recursive: true })
      cleanStaleFiles()
    } catch (e) {
      warn(`persistence disabled: ${e.message}`)
    }
    
    // Register event handlers (Phase 2: monitoring)
    eventHandlers = registerHandlers(client)
    
    // Register recovery verification hook (Phase 4: tool.started → recovery verified)
    // Phase 2 的 handleToolStarted 不處理 recovery verification，由這裡補上。
    eventHandlers.push(client.on('tool.started', event => {
      const sid = getSessionID(event)
      if (!sid) return
      const state = getState(sid)
      if (!state) return
      // Recovery verification: tool.started 表示模型已醒來且開始行動
      if (state.recoveryState === 'injected') {
        clearRecoveryVerification(state)
        handleRecoverySuccess(state, event)
        log(`[OK] [${sid}] recovery verified via tool.started`)
      }
      // Release processing guard (模型醒了)
      if (state.processingGuard) state.processingGuard = false
    }))
    
    // Register injection hook (Phase 4: tool.completed → checkAndInject)
    eventHandlers.push(client.on('tool.completed', async event => {
      const sid = getSessionID(event)
      if (!sid) return
      try {
        await checkAndInject(sid)
      } catch (e) {
        err(`[INJECT] checkAndInject error for ${sid}: ${e.message}`)
      }
    }))
    
    // ⚠️ CRITICAL: Register user intervention handler (Phase 4: message.completed → handleUserMessage)
    // Phase 2 的 registerHandlers 只註冊了 exchange counting (handleMessageCompleted)
    // 這裡補上使用者訊息處理（計數器重置、60s cooldown、命令解析）
    eventHandlers.push(client.on('message.completed', event => {
      const sid = getSessionID(event)
      if (!sid) return
      const state = getState(sid)
      if (!state) return
      const role = event.info?.role || event.properties?.role
      if (role !== 'user') return
      // 使用 event.text || event.info?.text || event.properties?.text 多來源適配
      const text = event.text || event.info?.text || event.properties?.text || ''
      handleUserMessage(state, text, sid)
    }))
    
    // Log startup
    log(`[OK] smart-heartbeat-local v1 started (model: ${detectModelProfile(opencode)})`)
  },
  
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
      ['cleanup', () => log('[OK] shutdown complete'), 1000],
    ])
  },
}

function handlePluginCrash(err) {
  try {
    err('[FATAL] smart-heartbeat-local crashed:', err.message)
    err('[FATAL] stack:', err.stack)
    clearAllTimers()
  } catch (_) {}
}

async function safeOnStop(steps) {
  for (const [name, fn, timeoutMs] of steps) {
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timeout`)), timeoutMs))
      ])
    } catch (e) {
      warn(`[SHUTDOWN] step ${name} failed: ${e.message}`)
    }
  }
}

// onStop 時繞過 debounce 直接寫入，確保關閉前資料落地
// 使用 state.js 的 immediatePersist（跳過 5s debounce）並 await 所有寫入完成
async function persistAllStates() {
  const writes = []
  for (const [sid, state] of states.entries()) {
    clearPersistenceDebounce(sid)
    writes.push(immediatePersist(sid, state))
  }
  await Promise.all(writes)
}
```

**Task 4.2: Start crash handler + heartbeatDisabled check**

```javascript
// 每個 inject 檢查前先確認是否被停用
// 邏輯: disabled → skip; user_active + idle>120s → auto-resume; cooldown → skip; 其餘放行
function shouldSkipInjection(state) {
  if (state.heartbeatDisabled) return true
  if (state.interventionState === 'user_active') {
    const idleTime = Date.now() - state.userLastActiveTime
    if (idleTime > 120000) {
      // Auto-resume after 2min idle
      state.interventionState = 'none'
      state.heartbeatCooldownUntil = 0
      return false
    }
    // Cooldown 期間阻止 injection（handleUserMessage 設定的 60s 初始靜默期）
    if (Date.now() < state.heartbeatCooldownUntil) return true
  }
  // user_active 但 cooldown 已過期 + idle < 120s → 允許 injection
  return false
}
```

**Task 4.3: User intervention — message handler**

在 `tool.started` / `message.completed` 中檢查使用者訊息：

```javascript
function handleUserMessage(state, text, sessionID) {
  // Reset ALL counters — user has taken control
  clearRecoveryVerification(state)
  
  state.interventionState = 'user_active'
  state.userLastActiveTime = Date.now()
  state.userInterventionCount++
  
  // Full counter reset (user message = clean slate)
  // 🟢 DESIGN DECISION: contextWarnings 不重置
  //   context 壓力是物理限制，使用者訊息無法釋放 context
  //   若重置，死亡螺旋 Method 3 (contextPressure + truncation) 將不再觸發
  //   此行為與 design doc §2b 不同 — 以 Phase 4 plan 為準
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
  
  // 60s cooldown — 給使用者空間操作
  state.heartbeatCooldownUntil = Date.now() + 60000
  
  // Parse commands (安全：text 可能為 undefined)
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
```

**Task 4.4: Operational observability — showStatusToUser + autoNotify**

```javascript
function showStatusToUser(summary) {
  // Priority: showToast > log
  try {
    if (typeof opencodeRef?.showToast === 'function') {
      opencodeRef.showToast(summary, 'info')
    }
  } catch (_) {}
  log(`[STATUS]\n${summary}`)
}

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
  warn(`[NOTIFY] [${sessionID}] ${msg}`)
}

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
```

**Task 4.5: Injection loop — 觸發時機 (async)**

```javascript
// 在 tool.completed 觸發
// 設計參考 §假設 5 — todo 讀取適配層
//
// 執行流程:
//   checkAndInject(sessionID)
//     ├─ shouldSkipInjection → skip (heartbeatDisabled / cooldown / intervention)
//     ├─ processingGuard timeout check → force-release if stale
//     ├─ in-flight tool timeout check → warn if stale
//     ├─ detectTruncation(state, prevTodos, currentTodos, config) → 3 methods
//     │    └─ truncated=true → shouldAttemptRecovery → executeRecovery
//     └─ injectContinuation → tool error / stuck / normal 續行

// 用於 Method 1 的 todo 快取
let previousTodosForSession = {}

async function checkAndInject(sessionID) {
  const state = getState(sessionID)
  if (!state) return
  
  // Unified skip check: heartbeatDisabled + intervention + cooldown
  if (shouldSkipInjection(state)) return
  
  // Processing guard: 模型可能還在 processing 上次注入的 prompt
  // 但有 timeout 保護 — 若 guard 卡住太久 (> countdown×2 或 120s)，強制釋放
  if (state.processingGuard) {
    const guardAge = Date.now() - (state.lastInjectionTime || 0)
    if (guardAge > Math.max(activeConfig.countdownSeconds * 1000 * 2, 120000)) {
      warn(`[GUARD] force-release stale processingGuard after ${guardAge}ms for ${sessionID}`)
      state.processingGuard = false
    } else {
      return
    }
  }
  
  // In-flight tool
  if (state.waitingForTool) {
    // Check if tool timed out
    if (state.inFlightTool && Date.now() - state.inFlightTool.startTime > state.inFlightTool.timeout) {
      warn(`[INJECT] in-flight tool ${state.inFlightTool.name} timed out for ${sessionID}`)
    } else {
      return
    }
  }
  
  // Read todos via adapter (try API → fallback to persistence)
  const todos = await readTodos(clientRef, opencodeRef, sessionID, persistDir)
  
  if (todos.length === 0) {
    // No pending todos = all tasks done → skip normal injection
    // Still check truncation for recovery (edge: recovery needed even with empty todos)
    // ⚠️ 空 todos 時不執行 injectContinuation (避免產生「下一項：」空任務名的混淆 prompt)
    const currentSnapshot = []
    const prevSnapshot = previousTodosForSession[sessionID] || []
    const truncResult = detectTruncation(state, prevSnapshot, currentSnapshot, activeConfig)
    previousTodosForSession[sessionID] = currentSnapshot
    if (truncResult.truncated && shouldAttemptRecovery(state, activeConfig)) {
      await executeRecovery(sessionID, state, todos, clientRef, activeConfig)
    }
    return  // ← 關鍵：跳過 injectContinuation
  }
  
  // === Step 1: Truncation detection (trigger for recovery) ===
  const currentSnapshot = todos.map(t => ({ content: t.content, status: t.status }))
  const prevSnapshot = previousTodosForSession[sessionID] || []
  const truncResult = detectTruncation(state, prevSnapshot, currentSnapshot, activeConfig)
  previousTodosForSession[sessionID] = currentSnapshot  // 更新快取
  
  if (truncResult.truncated) {
    log(`[TRUNC] detected via ${truncResult.method} (confidence: ${truncResult.confidence}) for ${sessionID}`)
    if (shouldAttemptRecovery(state, activeConfig)) {
      executeRecovery(sessionID, state, todos, clientRef, activeConfig)
    }
    return  // recovery 執行後返回，不再進行 normal injection
  }
  
  // === Step 2: Recovery state machine (if already in progress) ===
  if (state.recoveryState !== 'idle') {
    if (shouldAttemptRecovery(state, activeConfig)) {
      executeRecovery(sessionID, state, todos, clientRef, activeConfig)
    }
    return
  }
  
  // === Step 3: Normal continuation (tool error / stuck / normal) ===
  // injectContinuation 內部會呼叫 determinePromptType 決定 prompt 類型
  // 優先級: recovery > toolError > stuck > normal
  await injectContinuation(sessionID, state, todos, clientRef, activeConfig)
}
```

> **Todo 讀取適配層：** `readTodos()` 定義在 `utils.js`（見 Phase 1 Task 1.10b），支援三種後端 — `client.session.getTodos()`、`opencode.session.todos`、persistence fallback。具體可用性由 `verify-api.js` 第 5 項驗證決定。若 persistence fallback 是唯一方案，state persistence 的 debounce 須從 5s 降到 1s（修改 `02-state-monitoring.md` Task 2.2 的 `persistState` debounce 時間）。
>
> **Import 注意：** `persistDir` 需從 `state.js` 匯入：`const { persistDir } = require('./state')`。勿直接硬編碼路徑在 `index.js`。

## Task 4.6: Update opencode.json

```json
{
  "plugins": ["smart-heartbeat-local"],
  "heartbeat": {
    "enabled": true,
    "countdownSeconds": 30,
    "minIntervalMs": 90000,
    "maxStuckCycles": 8,
    "maxToolErrors": 8,
    "maxRepeatedTool": 10,
    "maxIdleSeconds": 120,
    "logLevel": "warn"
  }
}
```

所有欄位 optional，plugin 有完整預設值。

## Phase 4 單元測試

### task/phase4-intervention.test.js — 6 cases

| 測試目標 | 案例 | 測試重點 |
|---------|------|---------|
| User message resets counters | 1 | recoveryAttempts/deathSpiral/truncationEvents 全部歸零 |
| 60s cooldown blocks injection | 1 | cooldown 期間 shouldSkipInjection 回傳 true |
| 120s auto-resume | 1 | idle >120s 後 shouldSkipInjection 回傳 false |
| /heartbeat disable | 1 | state.heartbeatDisabled = true |
| /heartbeat enable | 1 | 恢復正常 injection |
| /heartbeat status output | 1 | buildStatusSummary 回傳非空字串 |

```javascript
// User message resets everything
const state = createOrGetState('test-ses')
state.recoveryAttempts = 3
state.deathSpiral = true
state.toolErrorCount = 8
handleUserMessage(state, 'test message', 'test-ses')
assert.strictEqual(state.recoveryAttempts, 0)  // reset
assert.strictEqual(state.deathSpiral, false)    // reset
assert.strictEqual(state.toolErrorCount, 0)     // reset

// Cooldown
assert(Date.now() < state.heartbeatCooldownUntil)  // 60s cooldown active
assert.strictEqual(shouldSkipInjection(state), true)

// Auto-resume
state.userLastActiveTime = Date.now() - 180000  // 3min idle
assert.strictEqual(shouldSkipInjection(state), false)
```

### task/phase4-integration.test.js (module-level) — 4 cases

| 測試目標 | 案例 | 測試重點 |
|---------|------|---------|
| onStart crash handler | 1 | process.on('uncaughtException') 已註冊 |
| onStop timer cleanup | 1 | activeTimers Set 在 stop 後為空 |
| safeOnStop timeout | 1 | 卡住的步驟 timeout 後不阻擋後續步驟 |
| registerHandlers wiring | 1 | 8 個 event types 都有 handler |

```javascript
// simulate onStart → onStop cycle
// Phase 2 registerHandlers 註冊 4 個 + Phase 4 新增 3 個 (recovery verify, checkAndInject, user intervention) = 7
const handlers = registerHandlers(mockClient)
assert(handlers.length >= 4, 'Phase 2 should register tool.started/completed/error + message.completed')
// verify all handlers have .off()
handlers.forEach(h => assert.strictEqual(typeof h.off, 'function'))
```

## Checkpoint Gate #4

通過條件：
1. `onStart` 可在 OpenCode 中載入 plugin 不 crash
2. `onStop` 正確清理 timer 與 event handlers
3. `/heartbeat status` 輸出正確狀態摘要（透過 showToast 或 log）
4. 使用者訊息後 60s cooldown 確實阻止 injection
5. 120s idle auto-resume 正確恢復 heartbeat
6. `handlePluginCrash` 在 throw 後正確清理 timer

**Gate #4 通過後 plugin 功能完整，可開始測試。**
