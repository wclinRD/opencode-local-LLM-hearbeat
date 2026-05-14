# Phase 2 — State & Monitoring

**目標：** 建立 session state 管理、事件路由、工具監控與 context 壓力偵測。此階段讓 plugin 能「看」到 OpenCode 中發生的事。

**前置條件：** Gate #1 通過（config.js, utils.js 就緒，API behavior 已確認）

**設計參考：** `2026-05-13-heartbeat-local-llm.md` §Session State、§In-Flight Tool 追蹤、§Context 壓力監控、§進度持久化、§Event Interleaving Rules

---

## TODO 列表

LLM 實作時依序執行，每完成一項用 `todowrite` 設為 completed：

| # | 任務 | 檔案 | 行數估計 | 類型 |
|---|------|------|---------|------|
| 2.1 | Session state shape + `createOrGetState` — Map<sessionID, State> + LRU (max 50) | state.js | ~80 | 結構 |
| 2.2 | `persistState` + `clearPersistenceDebounce` — debounced atomic write (.tmp → rename) | state.js | ~40 | 持久化 |
| 2.3 | `cleanStaleFiles` (>24h) + `removeState` (LRU eviction 安全清理) | state.js | ~30 | 維護 |
| 2.3b | `loadFromPersistence(sessionID)` + `loadAllFromPersistence` (onStart 載入) — 從磁碟恢復 recovery state (含 `inflateStateFromPersist`) | state.js | ~30 | 恢復 |
| 2.4 | `handleToolStarted` — in-flight tracking + repeated tool (recovery verification deferred to Phase 4 to avoid circular dep) | monitor.js | ~30 | 監控 |
| 2.5 | `handleToolCompleted` + `handleToolError` — history (max 20) + error accumulation | monitor.js | ~35 | 監控 |
| 2.6 | `handleMessageCompleted` — exchangeCount (+1 per user message, FIX) | monitor.js | ~15 | 監控 |
| 2.7 | `updateContextPressure` — largeOutputCount + contextWarnings | monitor.js | ~15 | 監控 |
| 2.8 | `checkStuckState(state, todos, config)` — tool_loop / tool_errors / idle triple signal | monitor.js | ~20 | 監控 |
| 2.9 | `detectTruncation(prevState, currentState, config)` → `{ truncated, method, confidence }` — 3 種方法偵測 context 截斷 | monitor.js | ~30 | 監控 |
| 2.10 | Update `index.js` — `registerHandlers` 事件路由 (tool.started/completed/error + message.completed) | index.js | ~40 | 整合 |
| 2.11 | `phase2-state.test.js` — 12 cases (LRU×2 / persist×2 / stale×1 / exchangeCount×2 / createOrGet×2 / remove×1 / loadFromPersistence×2) | test/ | ~70 | 測試 |
| 2.12 | `phase2-monitor.test.js` — 12 cases (handleToolStarted×2 / handleToolCompleted×2 / handleToolError×2 / checkStuckState×2 / detectTruncation×4) | test/ | ~70 | 測試 |
| 2.13 | **Gate #2 驗證** — 事件記錄正確 / stuck detection 3 情境 / truncation detection 3 方法 / exchangeCount bug fix / persistence round-trip / LRU eviction | — | — | 檢查點 |

**實作順序：** 2.1→2.2→2.3→2.4→2.5→2.6→2.7→2.8→2.9→2.10→2.11→2.12→2.13

---

## 檔案架構

```
.opencode/plugins/smart-heartbeat-local/
├── state.js       # Session state + persistence + event router (NEW)
├── monitor.js     # Tool monitoring + context pressure + stuck (NEW)
└── index.js       # Update: register event handlers + wire state/monitor
```

## Module: state.js

**Exports:**
- `createOrGetState(sessionID)` → `{ state }` — 建立或取得 session state
- `getState(sessionID)` → `{ state | undefined }`
- `getStatesMap()` → `{ Map }` — 回傳內部 states Map（供測試驗證 LRU / eviction）
- `removeState(sessionID)` — 清理 session（LRU 用）
- `persistState(sessionID, state)` — debounced atomic write
- `immediatePersist(sessionID, state)` — 繞過 debounce 立即寫入 (for onStop)
- `buildPersistData(sessionID, state)` — 共用資料序列化，供 persistState / immediatePersist 使用 (v2: 含完整 recovery state)
- `inflateStateFromPersist(sessionID, data)` — 從序列化資料重建 state (含 recovery 狀態機恢復)
- `loadFromPersistence(sessionID)` → `{ state | null }` — 從磁碟恢復單一 session
- `loadAllFromPersistence()` → `{ number }` — onStart 批次恢復所有 session
- `cleanStaleFiles()` — 清理 >24h 的 persistence 檔案
- `clearPersistenceDebounce(sessionID)` — 清除 pending debounce write
- `persistDir` — 字串常數 `.opencode/heartbeat-state/`，供 readTodos 作為 fallback 路徑 (NEW)

### 實作任務

**Task 2.1: Session state 完整 shape**

```javascript
const MAX_SESSIONS = 50

const states = new Map()  // Map<sessionID, State>

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
    toolCallHistory: [],        // [{name, time, status}], max 20
    toolErrorCount: 0,
    lastToolName: null,
    lastToolTime: null,
    repeatedToolCount: 0,
    toolCallCount: 0,
    inFlightTool: null,         // { name, startTime, timeout }
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
    recoveryState: 'idle',      // idle | injected | verified | failed | stopped
    recoveryLevel: 0,
    recoveryAttempts: 0,
    lastRecoveryTime: 0,
    recoveryVerificationStage1: null,
    recoveryVerificationStage2: null,
    recoveryQuality: 'unknown',
    truncationEvents: [],       // [{time, success}] ring buffer, max 10
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
```

**Task 2.2: Persistence — debounced atomic writes + immediate write for onStop**

```javascript
const persistDir = '.opencode/heartbeat-state/'  // 需 export，供 index.js 的 readTodos fallback 使用
const debounceTimers = new Map()  // sessionID → setTimeout id

// 共用資料序列化 (export 供 Phase 4 persistAllStates 複用)
// 保存完整的 recovery state，確保重啟後可正確重建死亡螺旋防護
function buildPersistData(sessionID, state) {
  return {
    sessionID,
    version: 2,                      // v2: 加入完整 recovery 狀態機欄位
    updated: new Date().toISOString(),
    // → 任務狀態 (供 readTodos fallback 使用)
    incomplete: state.toolCallHistory.filter(t => t.status !== 'completed'),
    currentTask: state.lastToolName,
    // → 工具統計
    toolErrorCount: state.toolErrorCount,
    toolCallCount: state.toolCallCount,
    repeatedToolCount: state.repeatedToolCount,
    exchangeCount: state.exchangeCount,
    // → Recovery 狀態機 (v2 新增 — 確保重啟後不遺失死亡螺旋知識)
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

// 從序列化資料重建 state (給 loadFromPersistence 使用)
// 只重建持久化欄位，runtime-only 欄位 (如 timer ID) 不保存
function inflateStateFromPersist(sessionID, data) {
  const state = createOrGetState(sessionID)
  if (data.version >= 2) {
    // v2: 完整恢復 recovery 狀態機
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
  // 工具統計 (所有版本)
  state.toolErrorCount = data.toolErrorCount || 0
  state.toolCallCount = data.toolCallCount || 0
  state.repeatedToolCount = data.repeatedToolCount || 0
  state.exchangeCount = data.exchangeCount || 0
  state.lastToolName = data.currentTask || null
  return state
}

// Debounced atomic write（運行中頻繁寫入用，避免 I/O 風暴）
function persistState(sessionID, state) {
  if (debounceTimers.has(sessionID)) clearTimeout(debounceTimers.get(sessionID))
  
  const data = buildPersistData(sessionID, state)
  
  debounceTimers.set(sessionID, setTimeout(async () => {
    debounceTimers.delete(sessionID)
    const filePath = path.join(persistDir, `${state.sessionIDSafe}.json`)
    const tmpPath = filePath + '.tmp'
    try {
      await fs.promises.writeFile(tmpPath, JSON.stringify(data), 'utf8')
      await fs.promises.rename(tmpPath, filePath)
    } catch (e) {
      warn(`[PERSIST] write failed for ${sessionID}: ${e.message}`)
    }
  }, 5000))  // debounce 5s
}

// 跳過 debounce 的立即寫入（供 onStop 使用，確保關閉前資料落地）
async function immediatePersist(sessionID, state) {
  const data = buildPersistData(sessionID, state)
  const filePath = path.join(persistDir, `${state.sessionIDSafe}.json`)
  const tmpPath = filePath + '.tmp'
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(data), 'utf8')
    await fs.promises.rename(tmpPath, filePath)
  } catch (e) {
    warn(`[PERSIST] immediate write failed for ${sessionID}: ${e.message}`)
  }
}

function clearPersistenceDebounce(sessionID) {
  if (debounceTimers.has(sessionID)) {
    clearTimeout(debounceTimers.get(sessionID))
    debounceTimers.delete(sessionID)
  }
}
```

**Task 2.3: Stale file cleanup + LRU eviction safe removal**

```javascript
async function cleanStaleFiles() {
  try {
    const files = await fs.promises.readdir(persistDir)
    const now = Date.now()
    const maxAge = 24 * 60 * 60 * 1000
    let cleaned = 0
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const stat = await fs.promises.stat(path.join(persistDir, file))
      if (now - stat.mtimeMs > maxAge) {
        await fs.promises.unlink(path.join(persistDir, file))
        cleaned++
      }
    }
    if (cleaned > 0) log(`[PERSIST] cleaned ${cleaned} stale files`)
  } catch (e) {
    // 非必要功能，降級
    warn(`[PERSIST] cleanup failed: ${e.message}`)
  }
}

function removeState(sessionID) {
  if (states.has(sessionID)) {
    clearPersistenceDebounce(sessionID)
    states.delete(sessionID)
  }
}

// 供測試驗證 LRU eviction / 內部狀態 — 不應在 production code 中使用
function getStatesMap() { return states }

// 從磁碟恢復指定 session 的 persistence 資料
// 用於 (1) onStart 重啟後恢復 recovery state (2) Phase 4 index.js 啟動時恢復
// 回傳重建後的 state，若檔案不存在或損毀回傳 null
async function loadFromPersistence(sessionID) {
  const safeID = sanitizeSessionID(sessionID)
  const filePath = path.join(persistDir, `${safeID}.json`)
  try {
    const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'))
    if (!data || !data.sessionID) return null
    // 使用 inflateStateFromPersist 重建 state (含 recovery 狀態機)
    return inflateStateFromPersist(sessionID, data)
  } catch (_) {
    return null  // 檔案不存在或 JSON 損毀 → 靜默降級
  }
}

// 掃描 persistence 目錄，載入所有 session state
// 在 onStart 時呼叫，確保重啟後 recovery 知識不遺失
async function loadAllFromPersistence() {
  let loaded = 0
  try {
    const files = await fs.promises.readdir(persistDir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const sessionID = file.replace(/\.json$/, '')
      const state = await loadFromPersistence(sessionID)
      if (state) loaded++
    }
    if (loaded > 0) log(`[PERSIST] restored ${loaded} session states from disk`)
  } catch (_) {
    // persistence 目錄不存在或不可讀 → 靜默 (無需 log, onStart 會處理)
  }
  return loaded
}
```

## Module: monitor.js

**Exports:**
- `handleToolStarted(state, event)` — 記錄 tool name/time，處理 recovery verification
- `handleToolCompleted(state, event)` — 記錄完成，重設 error count，清除 _cachedContextSize
- `handleToolError(state, event)` — 累計錯誤，判斷 threshold
- `handleMessageCompleted(state, event)` — 使用者訊息處理，計 exchangeCount
- `checkStuckState(state, todos, config)` → `{ stuck, reason, detail }`
- `updateContextPressure(state, toolOutputSize)` — 累計大 output 次數
- `detectTruncation(state, previousTodos, currentTodos, config)` → `{ truncated, method, confidence }`
- ~~`releaseProcessingGuard(state)`~~ — (由 handleToolStarted 內聯處理，已移除)

### 實作任務

**Task 2.4: In-flight tool tracking (FIX — I1: use config.toolTimeout)**

```javascript
// LOCAL COPY of defaults. handleToolStarted 使用 config.toolTimeout (seconds, config schema)，
// 乘以 1000 轉為 ms。只有在 config 未提供時才 fallback 到此硬編碼值。
// 此處不重複定義以消除重複，直接由 event router 從上層傳入 config。
// DESIGN DECISION: config.toolTimeout 的單位為秒（與其他 config 時間欄位一致），
// 此處取用時轉為 ms 供 setTimeout 使用。

function handleToolStarted(state, event, config) {
  state.lastActivity = Date.now()
  state.processingGuard = false  // Model "woke up"
  // V1: event.properties?.tool 尚未經 verify-api.js 確認是否存在。
  // verify-api.js 第 2 項應記錄 tool.started payload 的實際 key 名稱。
  // 若 payload 中無 tool 欄位，此 fallback 不會命中，改回只用 event.properties?.name。
  const toolName = event.properties?.name || event.properties?.tool || 'unknown'
  
  // NOTE: Recovery verification (tool.started → recovery verified)
  // will be handled in Phase 4 index.js event router, NOT here.
  // This avoids Phase 2 → Phase 3 circular dependency.
  // Phase 4 tasks: check recoveryState === 'injected' → clearRecoveryVerification() + handleRecoverySuccess()
  
  // Track same-tool repetition
  if (state.lastToolName === toolName) {
    state.repeatedToolCount++
  } else {
    state.repeatedToolCount = 0
  }
  
  // In-flight tracking — 優先使用 config.toolTimeout，fallback 到內建預設值 (ms)
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
```

**Task 2.5: Tool completed + error handlers**

```javascript
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
  
  // Invalidate context cache — 下次 estimateContextTokens 重新計算
  // context 隨 toolCallHistory 成長，cache 需每次 tool 完成後失效
  state._cachedContextSize = undefined
}
```

**Task 2.6: Message completed + exchange counting (FIX)**

```javascript
function handleMessageCompleted(state, event) {
  const role = event.info?.role || event.properties?.role
  if (role === 'user') {
    state.exchangeCount++  // 獨立於 toolCallHistory，用於 context 估算修正
    // 使用者介入邏輯另由 user intervention module 處理
  }
}
```

**Task 2.7: Context pressure monitoring**

```javascript
function updateContextPressure(state, toolOutputSize) {
  if (toolOutputSize > 2000) state.largeOutputCount++
  if (state.largeOutputCount >= 3) state.contextWarnings++
  // contextWarnings >= 3 → pre-recovery check 阻止復原注入
}
```

**Task 2.8: Stuck detection — todo + tool + idle triple signal**

```javascript
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
```

**Task 2.9: Truncation detection — 3 methods**

```javascript
// 三種方法偵測 context 截斷（truncation）
// 此函數是 recovery state machine 的觸發條件
// 在 Phase 3 executeRecovery 前被 checkAndInject 呼叫
function detectTruncation(state, previousTodos, currentTodos, config) {
  const result = { truncated: false, method: null, confidence: 0 }
  
  // Method 1: Todo state regression
  // Truncation 後 in_progress/resumed 任務常回到 pending
  // 比較 previousTodos 和 currentTodos：
  //   若 previous 中有 in_progress 但 current 中全部 pending →
  //   高機率 truncation
  if (previousTodos && currentTodos && previousTodos.length > 0) {
    const hadProgress = previousTodos.some(t => t.status === 'in_progress')
    const allPending = currentTodos.every(t => t.status !== 'in_progress')
    if (hadProgress && allPending) {
      result.truncated = true
      result.method = 'todo_regression'
      result.confidence = 0.8
      return result
    }
  }
  
  // Method 2: Repeated tool calls after gap
  // Truncation 後模型可能重複 truncation 前的工具呼叫
  const history = state.toolCallHistory || []
  if (history.length >= 4) {
    const recent = history.slice(-3)
    const older = history.slice(-6, -3)
    // 若最近 3 筆與前 3 筆的工具名稱完全相同 → 可能 loop（截斷後重複）
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
  // 若 _cachedContextSize 突然下降（如從 20000 → 15000）而沒有對應的
  // compact/cleanup event，可能是 truncation
  if (state._cachedContextSize !== undefined && state._previousContextSize !== undefined) {
    const drop = state._previousContextSize - state._cachedContextSize
    if (drop > 3000) {  // 突然下降超過 3000 tokens
      result.truncated = true
      result.method = 'context_drop'
      result.confidence = 0.7
      return result
    }
  }
  // 記錄當前 context size 供下次比較
  state._previousContextSize = state._cachedContextSize
  
  return result
}
```

> **何時呼叫：** `detectTruncation` 在 Phase 4 的 `checkAndInject` 中（tool.completed 後）被呼叫。若回傳 truncated=true，則觸發 recovery pipeline（`shouldAttemptRecovery → executeRecovery`）。
>
> **`previousTodos` 的來源：** Phase 4 的 `checkAndInject` 需在每次 tool.completed 時快取前一次的 todos 狀態。可放在 state 中或 module 變數中。
>
> **Method 2 的設計考量：** 模型正常執行也可能重複 tool（例如多次 edit）。confidence 設 0.6 表示此方法僅作為輔助訊號，不單獨觸發 recovery。需搭配其他方法或 stuck 訊號。

> **注意：** `handleToolCompleted` 應清除 `_cachedContextSize`，確保下次 `estimateContextTokens` 重新計算：
> ```javascript
> function handleToolCompleted(state, event) {
>   state._cachedContextSize = undefined  // 清除 cache，強制下次重新估算
>   // ... 原有邏輯
> }
> ```

**Task 2.10: Event router in index.js (FIX — I1: pass config to handleToolStarted)**

在 `index.js` 中註冊事件 handler，分派到對應 module。
使用通用 helper `getSessionID(event)` 處理多種 payload 格式（由 verify-api.js 確認實際結構）。
Phase 4 的 onStart 會在載入 config 後才呼叫 `registerHandlers(client, activeConfig)`。

```javascript
// 通用 event → sessionID 提取器 (Phase 4 也會共用)
function getSessionID(event) {
  return event.properties?.sessionID || event.info?.sessionID || event.sessionID
}

// config 參數：傳入 activeConfig 供 handleToolStarted 讀取 config.toolTimeout
function registerHandlers(client, config) {
  const handlers = []
  
  handlers.push(client.on('tool.started', event => {
    const sid = getSessionID(event)
    if (!sid) return
    const state = getState(sid)
    if (!state) return
    handleToolStarted(state, event, config)  // FIX: 傳入 config 避免硬編碼 TOOL_TIMEOUTS
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
  
  return handlers  // for cleanup on onStop
}
```

## Phase 2 單元測試

### task/phase2-state.test.js — 12 cases

| 測試目標 | 案例 | 測試重點 |
|---------|------|---------|
| LRU eviction | 2 | >50 session 時 evict 最舊 / evict 後新 session 可正常建立 |
| Persistence write | 2 | 寫入後讀取回 verification / .tmp 原子寫入順序 |
| Stale file cleanup | 1 | >24h 的檔案被刪除 / <24h 保留 |
| exchangeCount (FIX) | 2 | `handleMessageCompleted` role=user 時 +1 / 非 user 不計 |
| createOrGetState | 2 | 新 session 建立 / 既有 session 回傳舊物件 |
| removeState | 1 | 清理後 states map 中消失 |
| loadFromPersistence | 2 | 寫入→立即讀取回正確 (含 deathSpiral=true 重建) / 檔案不存在回傳 null |

```javascript
// LRU eviction (使用 getStatesMap 存取內部 states)
const statesMap = getStatesMap()
for (let i = 0; i < 52; i++) createOrGetState(`ses_${i}`)
assert(statesMap.has('ses_51'))           // 最新的存在
assert(!statesMap.has('ses_0'))           // 最舊的被 evict
assert(!statesMap.has('ses_1'))           // 第二舊也被 evict
assert.strictEqual(statesMap.size, 50)    // 保持上限
```

### task/phase2-monitor.test.js — 12 cases

| 測試目標 | 案例 | 測試重點 |
|---------|------|---------|
| handleToolStarted | 2 | 正確記錄 name/time / 釋放 processing guard / 重複 tool 累計 |
| handleToolCompleted | 2 | 記錄完成狀態 + 清除 _cachedContextSize / 釋放 in-flight |
| handleToolError | 2 | 累計 errorCount / toolErrorsByTool 正確 |
| checkStuckState | 2 | tool_loop / tool_errors / idle / 正常 (4 種輸出, 2 個 test 各 cover 2 cases) |
| detectTruncation | 4 | Method 1 todo_regression / Method 2 repeated_calls / Method 3 context_drop / 無 truncation |

```javascript
// loadFromPersistence: 寫入後重建驗證
const persistFile = path.join(persistDir, 'test-load.json')
const testData = { sessionID: 'test-load', version: 2, deathSpiral: true, recoveryState: 'stopped', recoveryAttempts: 3, truncationEvents: [{time:100,success:false},{time:200,success:false},{time:300,success:false}] }
await fs.promises.mkdir(persistDir, { recursive: true })
await fs.promises.writeFile(persistFile, JSON.stringify(testData))
const loadedState = await loadFromPersistence('test-load')
assert(loadedState !== null)
assert.strictEqual(loadedState.deathSpiral, true)    // 恢復死亡螺旋標記
assert.strictEqual(loadedState.recoveryState, 'stopped')  // 恢復狀態機
assert.strictEqual(loadedState.recoveryAttempts, 3)
assert.strictEqual(loadedState.truncationEvents.length, 3)

// 不存在的 session
const nullState = await loadFromPersistence('nonexistent')
assert.strictEqual(nullState, null)

// Tool error accumulation
const state = createOrGetState('test-ses')
for (let i = 0; i < 5; i++) handleToolError(state, { properties: { name: 'bash', error: 'fail' } })
assert.strictEqual(state.toolErrorCount, 5)
assert.strictEqual(state.toolErrorsByTool.bash, 5)

// Repeated tool detection
handleToolStarted(state, { properties: { name: 'edit' } })
handleToolStarted(state, { properties: { name: 'edit' } })
handleToolStarted(state, { properties: { name: 'edit' } })
assert.strictEqual(state.repeatedToolCount, 3)

// detectTruncation — Method 1: todo regression
const prevTodos = [{ content: 'task A', status: 'in_progress' }, { content: 'task B', status: 'pending' }]
const currTodos = [{ content: 'task A', status: 'pending' }, { content: 'task B', status: 'pending' }]
const r1 = detectTruncation(state, prevTodos, currTodos, DEFAULT_CONFIG)
assert.strictEqual(r1.truncated, true)
assert.strictEqual(r1.method, 'todo_regression')

// detectTruncation — Method 2: repeated calls after gap
state.toolCallHistory = [
  { name: 'edit', time: 1000, status: 'ok' },
  { name: 'edit', time: 2000, status: 'ok' },
  { name: 'edit', time: 3000, status: 'ok' },
  { name: 'edit', time: 4000, status: 'ok' },
  { name: 'edit', time: 5000, status: 'ok' },
  { name: 'edit', time: 6000, status: 'ok' },
]
const r2 = detectTruncation(state, null, null, DEFAULT_CONFIG)
assert.strictEqual(r2.truncated, true)
assert.strictEqual(r2.method, 'repeated_calls')

// detectTruncation — no truncation
state.toolCallHistory = [{ name: 'edit', time: 1000, status: 'ok' }]
const r3 = detectTruncation(state, null, null, DEFAULT_CONFIG)
assert.strictEqual(r3.truncated, false)
```

## Checkpoint Gate #2

通過條件：
1. `handleToolStarted` 正確記錄 tool name/time/repeated count
2. `handleToolError` 累計 error count — 模擬 5 次錯誤後檢查 count
3. `handleToolCompleted` 清除 `state._cachedContextSize` — 驗證 cache 在下一次 tool completed 後失效
4. `checkStuckState` 在 tool loop / tool errors / idle 三種情境都回傳正確 stuck reason
5. `detectTruncation` 在 todo_regression / repeated_calls / context_drop 三種方法都回傳正確結果
6. `exchangeCount` 在使用者訊息後 +1（修正雙重計數 bug）
7. Persistence write → read → verify round-trip（模擬寫入後重啟可讀回）
8. 同一 session 超過 50 個時最舊的被 evict 且 state 清理

**Phase 3 開始前，monitor.js 的所有 exports（含 detectTruncation）都必須可被獨立呼叫且結果正確。**
