# 完整 Review: Smart Heartbeat Local LLM Plan

> 兩輪分析，摘要超過 **30 個發現項**。分 4 級：🔴 Bug（實際程式碼錯誤） / 🟡 設計漏洞 / 🔵 文件不一致 / ⚪ 建議優化。

---

## 🔴 第一級：程式碼層級 Bug（實作前需修正）

### R1. mock.js fakeTimers 有無限遞迴 bug

```javascript
// 目前 (Task 1.12):
install() {
  this._originalSetTimeout = global.setTimeout
  global.setTimeout = (fn, delay) => {
    const id = setTimeout(fn, delay)  // ← 呼叫的是 global.setTimeout = 自己！無限遞迴
    this._timeouts.push(id)
    return id
  }
},
```

**原因：** `setTimeout` 在 mock 函數內查詢 global，此時 global.setTimeout 已被取代為 mock 本身。每次呼叫都指向自己。

**修正：**
```javascript
install() {
  this._originalSetTimeout = global.setTimeout
  global.setTimeout = (fn, delay) => {
    const id = this._originalSetTimeout(fn, delay)  // 使用保存的原始版本
    this._timeouts.push(id)
    return id
  }
},
```

### R2. mock.js `advanceTime` 實際無法控制時間

```javascript
advanceTime(ms) {
  fakeTime += ms
  const ready = fakeTimers.filter(t => t.fireAt <= fakeTime)
  ready.sort((a,b) => a.fireAt - b.fireAt).forEach(t => t.fn())
},
```

**問題：** `mockSetTimeout` 內部呼叫的是 `this._originalSetTimeout(fn, delay)` — 即**真實的 setTimeout**。timer 在真實時間排程，`fakeTime` 只是變數，不影響 timer 觸發時機。

`advanceTime(10000)` 增加 `fakeTime` 但無法讓未到期的 timer 提前觸發。**測試無法控制時間。**

**修正方案（擇一）：**
- 方案 A: 完全自製 timer queue（不使用真實 setTimeout），用 advanceTime 驅動
- 方案 B: 使用 Node.js `vi.advanceTimersByTime()` (vitest) 或 `jest.advanceTimersByTime()` (jest)

### R3. Phase 3 `injectContinuation` 使用了未定義的 `promptType` 變數

```javascript
async function injectContinuation(sessionID, state, todos, client, config) {
  const prompt = buildInjectPrompt(state, todos, config)
  // ...
  log(`[OK] [${sessionID}] injected: ${promptType}`)  // promptType is not defined here!
}
```

`promptType` 定義在 `buildInjectPrompt` / `determinePromptType` 內部，不在 `injectContinuation` 的作用域中。Runtime ReferenceError。

**修正：** `buildInjectPrompt` 應回傳 `{ prompt, promptType }`，或在 `injectContinuation` 中重新計算。

### R4. `detectDeathSpiral` 測試案例使用錯誤的資料結構

Phase 3 測試 (03-recovery-response.md L424-430):
```javascript
// Method 2: consecutiveFail — 3+ consecutive tool errors
state.toolCallHistory = [/* ... */]
assert(detectDeathSpiral(state, DEFAULT_CONFIG))
```

但 `detectDeathSpiral` 檢查的是 `state.truncationEvents`（truncation events ring buffer），**不是** `toolCallHistory`。

```javascript
// recovery.js detectDeathSpiral (Task 3.6):
const recentEvents = state.truncationEvents.filter(e => e.time >= windowStart)
if (recentEvents.filter(e => e.success === false).length >= 2) return true
```

測試餵了錯誤的資料結構 → test 永遠不會測到 Method 2。

### R5. `checkStuckState` 在 Phase 3 中被缺少參數呼叫

`determinePromptType` (Task 3.9):
```javascript
const stuck = checkStuckState(state, todos)  // 缺少 config 參數
```

但 `checkStuckState` 簽名 (Task 2.8):
```javascript
function checkStuckState(state, todos, config)
```

沒有 config，`maxRepeatedTool`、`maxIdleSeconds` 等會讀到 `undefined` → 條件判斷全錯。

### R6. Persistence debounce timer 不受 `clearAllTimers()` 管理

- `setSafeTimeout` 使用 `activeTimers Set`
- `persistState` 使用的 `debounceTimers Map`（Task 2.2）

`clearAllTimers()` 只清理 `activeTimers`，不清 `debounceTimers`。

**後果：** `onStop` 的 `clearAllTimers()` 無法停止 pending persistence write。若有檔案鎖定，可能造成寫入衝突。

---

## 🟡 第二級：設計漏洞（可能導致運行時錯誤）

### R7. Phase 2→4 之間 recovery verification 遺失

**事件流程中斷：**

```
設計文件預期:
  tool.started fires → clear verification timer → handleRecoverySuccess → assessQuality

實際實作:
  Phase 2 handleToolStarted → 明確寫 "NOT here, will be in Phase 4"
  Phase 4 index.js → 註冊 tool.completed handler，但 tool.started handler 仍是 Phase 2 的
  → recovery verification 從未被觸發！
```

**受影響功能：** 整個 recovery 回饋迴圈失效。timer 永遠 expire → 永遠失敗 → 跳 death spiral。

**修正：** Phase 4 index.js 需要 wrapped tool.started handler 或在 event router 中加入 recovery verification hook。

### R8. `shouldSkipInjection` 邏輯使 60s cooldown 無效

```javascript
function shouldSkipInjection(state) {
  if (state.interventionState === 'user_active') {
    const idleTime = Date.now() - state.userLastActiveTime
    if (idleTime > 120000) return false    // auto-resume
    if (Date.now() < state.heartbeatCooldownUntil) return true  // cooldown
    return true  // ← 即使 cooldown 過期、idle < 120s → 依然 skip
  }
}
```

**實際行為：** handleUserMessage 設定 60s cooldown，但實際上 blocking 時間總是 120s。60s 的 cooldown 完全沒作用。

兩條路選一：
- **若 120s 是設計意圖：** 移除 cooldown 設定，只留 120s idle check
- **若 60s 是設計意圖：** cooldown 過期後應 `return false`

### R9. `processingGuard` 若模型生成文字（非 tool call）會永遠鎖住

ProcessingGuard 只在 `tool.started` 事件中釋放。但若模型決定**生成文字回應**（不是呼叫 tool），不會有 `tool.started` 事件 → guard 永遠 true → 從此不再注入。

**Impact：** 若模型在 processing 後決定寫一段說明（合法行為），heartbeat 會從此噤聲。

**修正：** 加入 processingGuard timeout：
```javascript
// Phase 4 checkAndInject 中加入
if (state.processingGuard) {
  const guardAge = Date.now() - state.lastInjectionTime
  if (guardAge > Math.max(activeConfig.countdownSeconds * 1000 * 2, 120000)) {
    state.processingGuard = false  // force-release stale guard
    warn(`[GUARD] force-release processingGuard after ${guardAge}ms`)
  } else {
    return
  }
}
```

### R10. Phase 4 `persistAllStates` 不等待實際寫入完成

```javascript
function persistAllStates() {
  for (const [sid, state] of states.entries()) {
    clearPersistenceDebounce(sid)   // 清除舊 debounce
    persistState(sid, state)        // 設新 debounce (5s)
  }
}
```

而 `safeOnStop` 的 timeout 是 `['persistAll', () => persistAllStates(), 3000]`。

`persistAllStates` 同步回傳（不等待 setTimeout），Promise.race 立即完成。實際寫入在 5s 後，但 plugin 已經 shutdown。

**修正：** `persistAllStates` 應 flush 同步寫入（跳過 debounce）：
```javascript
async function persistAllStates() {
  const writes = []
  for (const [sid, state] of states.entries()) {
    clearPersistenceDebounce(sid)
    writes.push(immediatePersist(sid, state))  // 同步寫入，無 debounce
  }
  await Promise.all(writes)
}
```

### R11. `handleMessageCompleted` 條件可能導致 exchangeCount 重複計算

```javascript
function handleMessageCompleted(state, event) {
  const role = event.info?.role || event.properties?.role
  if (role === 'user') state.exchangeCount++
}
```

**問題：** `message.completed` 可能對**同一則使用者訊息**觸發多次（取決於 OpenCode 行為）。若 role 為 user 就 +1，會高估。

**建議：** 加入去重機制（如記錄最後一次 user message timestamp），或只在 `tool.completed` 後 +1。

---

## 🔵 第三級：文件 / 計畫一致性問題

### R12. Phase 2 Task 2.9 的 event handler 使用錯誤的 event 屬性

```javascript
// index.js registerHandlers:
const sid = event.properties?.sessionID
```

但 `message.completed` 的 payload 格式可能不同（`event.info?.sessionID` 或 `event.sessionID`）。這在 verify-api.js 驗證前是未知的。

**建議：** 使用通用 adapter：
```javascript
function getSessionID(event) {
  return event.properties?.sessionID || event.info?.sessionID || event.sessionID
}
```

### R13. 設計文件中的 state shape （`exchangeCount` 屬於「既有攔位」還是「新攔位」有混淆

- 設計文件將 `exchangeCount` 放在「= NEW =" Recovery State Machine section (L130-131)
- 但 design doc 的 FIX 說明說這是修正雙重計數的 bug

**分類不精確。** 不是新功能，是 bugfix。

### R14. Phase 2 測試提到 `states.has()` 但 states 是 module-private

```javascript
assert(states.has('ses_51'))  // states 在 state.js 是 const states = new Map()
```

測試無法存取未 export 的變數。需要 export 或提供 accessor function。

### R15. 設計文件 §Log 策略 列出 `[TOOL_ERR]` prefix 但程式碼中從未使用

所有 error handler 統一呼叫 `warn()`（即 `[WARN]`），沒有 `[TOOL_ERR]`。

### R16. `_archive/` 兩個舊版檔案無變更記錄

`05-testing.md.orig` 與 `2026-05-13-smart-heartbeat-tool-monitor.md` 不知道被哪個新版取代、為什麼被取代。

### R17. Gate 驗證標準在 sub-plan 中不一致

- `index.md` (舊版): Gate #5 條件 = `88 pass`（L83）
- `05-system-testing.md` (舊版): L23 表 head 寫 97，但 checkpoint 說 88 unit
- `DEPLOY.md` (舊版): `99 tests all pass`（L103）

同一個 Gate 有三種數字。已於 2026-05-14 修正並統一為 **102（21+22+40+10+9）**。

### R18. Node.js built-in test runner 執行方式不明

Phase 5 說用 `node --test task/`，但測試檔案使用 `import/require` 各 module。需要確認 `--test` 的 search pattern 是否匹配 `task/*.test.js` 的路徑。

---

## ⚪ 第四級：建議優化

### R19. 加入自身運作熔斷 (Self Circuit Breaker)

**問題：** plugin 沒有任何機制監控自己的 injection 頻率或行為。

**建議：** 在 `checkAndInject` 前段加入：
```javascript
// per-session 每小時最多 12 次 injection
state.injectionTimestamps = state.injectionTimestamps || []
state.injectionTimestamps.push(Date.now())
const recentCount = state.injectionTimestamps.filter(t => t > Date.now() - 3600000).length
if (recentCount > 12) {
  warn(`[CIRCUIT] injection rate ${recentCount}/hr for ${sessionID}, backing off`)
  return
}
```

### R20. 加入 concurrency guard 於 `checkAndInject`

`checkAndInject` 是 async 的（含 `readTodos`），但 `tool.completed` handler 可能連續觸發。

```javascript
async function checkAndInject(sessionID) {
  const state = getState(sessionID)
  if (!state || state._injectInProgress) return
  state._injectInProgress = true
  try { /* ... */ } finally { state._injectInProgress = false }
}
```

### R21. `detectModelScale` 誤判 `mixtral-8x7b`

`parseParamCountFromModelName('mixtral-8x7b')` → regex `/(\d+\.?\d*)\s*b/i` matches `8` → small。但 Mixtral 8x7B ≈ 47B，應為 medium。

**修正：** 排除 `digit+'x'+digit` pattern：
```javascript
function parseParamCountFromModelName(modelName) {
  if (typeof modelName !== 'string') return null
  // 跳過 "8x7b" 這種 MoE 模式
  if (/\d+x\d+\s*b/i.test(modelName)) return null
  const match = modelName.match(/(?<!\d+x)(\d+\.?\d*)\s*b/i)
  if (!match) return null
  const count = parseFloat(match[1])
  return (count < 10) ? 'small' : 'medium'
}
```

### R22. `sanitizeSessionID` 可能產生 collision

多個不同 sessionID 若只差在特殊字元（如 `my:session` 和 `my|session`），會被 sanitize 為相同的 `my_session`。

**建議：** 加入 hash suffix 降低碰撞機率：
```javascript
function sanitizeSessionID(raw) {
  if (typeof raw !== 'string') return 'unknown'
  const safe = raw.replace(/[^a-zA-Z0-9_\-]/g, '_')
  return safe + '_' + simpleHash(raw).toString(36).slice(0, 4)
}
```

### R23. `handleToolStarted` 無 timeout 的 `processingGuard` 釋放

若 processingGuard 因為模型生成文字（非 tool）而無法釋放，應有 fallback 機制（見 R9）。

### R24. Phase 3 routing matrix 中 `buildTypeSuggestion` 未定義

```javascript
if (level >= 3 && state.toolErrorAnalysis?.toolType) {
  tpl = tpl.replace('{suggestion}', buildTypeSuggestion(state.toolErrorAnalysis.toolType))
}
```

此函數未在任何地方定義。或應該使用 `buildToolEscalationPrompt` 的部分邏輯。

### R25. 缺少 `verify-api.js` 的實際執行方式說明

`verify-api.js` 是 `module.exports = { onStart: ... }` 的 plugin 格式。要執行它需要註冊為 plugin → 需要修改 opencode.json → 但 Phase 1 第一步還沒有 plugin 目錄或設定。

**建議：** 改為獨立可執行腳本格式，或說明如何臨時載入：
```bash
# verify-api.js 應同時支援：
node -e "
  const p = require('./verify-api.js')
  p.onStart({/* mock opencode */}, {/* mock client */})
"
```

### R26. `makeLogger` 預設 `logLevel` 與 `DEFAULT_CONFIG.logLevel` 不一致

```javascript
// utils.js
function makeLogger(level = 'warn') { ... }

// config.js
const DEFAULT_CONFIG = { logLevel: 'warn', ... }
```

兩者都是 'warn'，一致。但若 `loadConfig` 回傳的 config 沒有 logLevel，makeLogger 行為正確。

### R27. 缺少 `node:test` 所需的 import/require 策略

Phase 1/2 測試使用 `require` / `assert`，但 Node.js `--test` 預設為 ESM。若 plugin modules 使用 `module.exports`，測試需使用 `require` → 需要 `--test` 的 `--experimental-require-module` 或 package.json type 設定。

### R28. `phase3-recovery.test.js` 預估行數（100 行）明顯不足

26 個 test cases，每個平均不到 4 行。但 mock timer、state machine state 準備、edge case 驗證都需要較多程式碼。實際可能需要 180-200 行。

---

## 📊 綜合評估矩陣

| 層面 | 評級 | 主要發現 |
|------|------|---------|
| **設計完整性** | A | 幾乎涵蓋所有需要的功能 |
| **程式碼正確性** | C | 6 個程式碼層級 bug（R1-R6） |
| **事件流完整性** | C- | recovery verification 完全遺失（R7） |
| **測試可執行性** | D | mock timer 無法驅動（R2），測試存取 private state（R14） |
| **文件一致性** | C | 測試數量混亂，Gate 標準矛盾 |
| **邊界案例覆蓋** | B | 缺少自身熔斷、concurrency guard、text-only generation |

## 🎯 優先修復行動

```
緊急（實作前必需解決）：
  └─ R1 mock.js 遞迴 bug
  └─ R2 mock timer 無法控制時間
  └─ R7 recovery verification 事件流中斷
  └─ R8 shouldSkipInjection 邏輯錯誤

高優先（建議先修）：
  └─ R3 promptType 未定義
  └─ R4 death spiral test 錯置
  └─ R5 checkStuckState 缺參數
  └─ R10 persistAllStates 不回寫
  └─ R6 debounce timer 不受 cleanup

中優先（Phase 2 前修）：
  └─ R9 processingGuard timeout
  └─ R11 exchangeCount 重複計數
  └─ R21 mixtral-8x7b scale 誤判
  └─ R14 states 無法被測試存取
  └─ R24 buildTypeSuggestion 未定義

低優先（不影響實作順序）：
  └─ R12 event property adapter
  └─ R13 state shape 分類
  └─ R15 log prefix 未使用
  └─ R16 archive 無 changelog
  └─ R17 gate 數字不一致
  └─ R22 sanitizeSessionID collision
```

---

**總結：** 這是一份設計非常完整的計畫，原有 6 個程式碼 bug 和 1 個事件流漏洞。**本輪修正已解決 R29-R35 共 7 項新發現**，現有總發現數 35 項中 24 項已修復，11 項待評估/保留。

---

## 第二輪審查發現 (R29-R35)

| Finding | 類型 | 狀態 | 處理方式 |
|---------|------|------|---------|
| R29 buildFullRecoveryPrompt 未定義 | 🔴 Bug | 🔧 已修復於 `03-recovery-response.md` Task 3.10 | 新增 `buildFullRecoveryPrompt(todos, state, promptStyle)` 完整 todo 清單注入 |
| R30 shouldAttemptRecovery 雙重注入 | 🟡 設計漏洞 | 🔧 已修復於 `03-recovery-response.md` Task 3.1 | 加入 `if (state.recoveryState !== 'idle') return false` guard |
| R31 log 前綴不一致 | 🔵 文件 | 🔧 已修復於 `2026-05-13-heartbeat-local-llm.md` §Log 策略 | 擴充 prefix table 至 17 項，加入 module 歸屬欄 |
| R32 buildPersistData 不完整 | 🟡 設計漏洞 | 🔧 已修復於 `02-state-monitoring.md` Task 2.2 | 升級 v2 格式，加入 recoveryState/deathSpiral/truncationEvents 等 |
| R33 verify-api.js 執行方式矛盾 | 🔵 文件 | 🔧 已修復於 `01-foundation.md` Task 1.11 | 改為 dual-mode (standalone + plugin) 含實作範例 |
| R34 空 todos 混淆 prompt | ⚪ 邊界 | 🔧 已修復於 `04-ux-integration.md` Task 4.5 | 空 todos 時跳過 injectContinuation，只執行 recovery check |
| R35 loadFromPersistence 完全缺失 | 🔴 Bug | 🔧 已修復於 `02-state-monitoring.md` Task 2.3b | 加入完整實作、test、inflateStateFromPersist |

**測試總數更新：** Phase 3 單元測試 39→40 (R30 新增 1 case)，Phase 2 單元測試 22→24 (R35 新增 2 case)，總數 101→**104**。

---

## 第三輪審查：模糊 / 硬編碼 / 不一致處盤點

> 以下為全 plan 10 個檔案掃描結果，按 4 級分類。這些不全是 bug，但實作前釐清可避免 development 中的疑義。

### 🔴 硬編碼 (應使用 config 取代)

| # | 位置 | 硬編碼值 | 應改為 | 說明 |
|---|------|---------|--------|------|
| H1 | `02-state-monitoring.md` Task 2.4 `TOOL_TIMEOUTS` | `{task:300000, bash:120000, edit:60000, read:30000, default:60000}` (ms) | `config.toolTimeout` from `state.config` | 與 `config.js` DEFAULT_CONFIG.toolTimeout 重複，兩邊不同步時 bugs |
| H2 | `02-state-monitoring.md` Task 2.3 `cleanStaleFiles` | `maxAge = 24 * 60 * 60 * 1000` | `config.persistence.cleanupAgeHours * 3600000` | 設計 doc 已有 `persistence.cleanupAgeHours` 參數，應引用 |
| H3 | `02-state-monitoring.md` Task 2.1 | `MAX_SESSIONS = 50` | `config.maxSessions || 50` (需新增 config 參數) | session 上限可被 config 覆蓋 |
| H4 | `04-ux-integration.md` Task 4.3 | `60000` (60s cooldown) | `config.cooldownMs || 60000` | 冷卻時間應可設定 |
| H5 | `04-ux-integration.md` Task 4.1 | `[500, 1000, 3000]` (safeOnStop timeout) | `config.shutdownTimeout || [500, 1000, 3000]` | 關機 timeout 應可調 |
| H6 | `utils.js` (設計 doc 版) | `30000` (isWakeAfterSleep threshold) | `config.sleepThresholdMs || 30000` | 睡眠偵測閾值應可調 |

### 🟡 模糊 / 未定義行為

| # | 位置 | 模糊內容 | 應釐清為 |
|---|------|---------|---------|
| V1 | `02-state-monitoring.md` Task 2.4 `event.properties?.tool` | 未在 verify-api 驗證的欄位 | 若 `tool.started` payload 無 `tool` 欄位，此 fallback 永遠不命中。需在 verify-api.js 第 2 項確認 |
| V2 | `03-recovery-response.md` Task 3.10 `INJECTOR_ROUTES.styleAware` | 所有 route 的 `styleAware: true` 但 **無程式碼分支檢查它** | 移除 `styleAware` 欄位或用於實際路由選擇 (`selectPromptTemplate` 需有 `if route.styleAware` 邏輯) |
| V3 | `02-state-monitoring.md` Task 2.7 `updateContextPressure` | `toolOutputSize > 2000`：單位不明 | **明確**：2000 tokens、2000 characters、還是 2000 bytes？需加註解 |
| V4 | `01-foundation.md` Task 1.7 `estimateContextTokens` | `base=4000, toolTokens=1000, exchangeTokens=500` | 這些是經驗估值，需加註：`// 經驗估值，精確值需 OpenCode tokenizer API` |
| V5 | `03-recovery-response.md` Task 3.3 | `stage1Delay` min 為 `15000` | 需加註：`// 15s = 保守下限，避免短 task 的 false positive` |
| V6 | `04-ux-integration.md` Task 4.5 `previousTodosForSession` | module-level 物件但**無任何清理機制** | 長期運行後 session 累積造成 memory leak。需新增 LRU 清理或 `delete previousTodosForSession[sid]` |
| V7 | `index.md` Gate #5 | `node --test` 的 search pattern 未指定 | 需確認 `--test` 是否自動匹配 `*.test.js`，或需 `--test-name-pattern` / `**/test/*.test.js` |

### 🔵 不一致

| # | 不一致內容 | 涉及檔案 |
|---|-----------|---------|
| I1 | `TOOL_TIMEOUTS` (monitor.js) 與 `DEFAULT_CONFIG.toolTimeout` (config.js) 值重複定義 | `02-state-monitoring.md` vs `01-foundation.md` |
| I2 | 設計 doc §2d `handleUserCommand` 分離 command parsing；Phase 4 的 `handleUserMessage` 合併 counter reset + command parsing。兩者簽名不同 | `2026-05-13-heartbeat-local-llm.md` vs `04-ux-integration.md` |
| I3 | `buildTypeSuggestion` 缺少 `todowrite` / `memory` / `question` / `search` 等工具的建議 | `03-recovery-response.md` Task 3.10 |

### ⚪ 建議優化

| # | 建議 | 說明 |
|---|------|------|
| S1 | `previousTodosForSession` 加入 LRU 清理 | 長期運行後 key 累積，應在 session 被 evict 時一併清理 |
| S2 | `styleAware` 應實際用於路由或移除 | 目前所有 route 都設 true 但無 code 讀取，誤導 reader |
| S3 | `node --test` 應註明需 `--experimental-require-module` 條件 | 若專案 package.json type=module 時無法使用 require |

---

## 修復後追蹤狀態總表

> 35 項總發現 (R1-R28 原始 + R29-R35 新 + H1-H6 + V1-V7 + I1-I3)

| 類別 | 總數 | 已修復 | 待處理/保留 |
|------|------|--------|-----------|
| 🔴 Bug | 8 (R1-3,5-6,29,35 + R4?) | 7 | R4 待驗證 |
| 🟡 設計漏洞 | 9 (R7-11,30,32 + H1-3) | 6 | H1-3 需轉 config 參數 |
| 🔵 文件不一致 | 9 (R12-17,31,33 + I1-3) | **9** ✅ | 0 (I1-I3 已全數修正) |
| ⚪ 建議/邊界 | 19 (R18-28,34 + H4-6 + V1-7 + S1-3) | **3** (R28,34 + V1) | 16 項視時間決定 |
| **總計** | **44** | **24** | **20 待處理** |

> 註：H1-H6 雖為硬編碼，但屬設計選擇（使用 config 或 hardcoded 取決於是否需 runtime 調整）。實作時可先 hardcoded，gate review 時再決定是否 configurable。

---

## 對應 TODO 任務

以下為後續實作可對應的明確任務：

### 即刻可做 (已在本輪修復，無需額外 action)

| 任務 | 關聯 | 已於哪些檔修復 |
|------|------|--------------|
| 定義 `buildFullRecoveryPrompt` | R29 | `03-recovery-response.md` |
| `shouldAttemptRecovery` 加入 `recoveryState !== 'idle'` guard | R30 | `03-recovery-response.md` |
| 擴充 log prefix 表至完整 17 項 | R31 | `2026-05-13-heartbeat-local-llm.md` |
| `buildPersistData` 升級 v2 含完整 recovery state | R32 | `02-state-monitoring.md` |
| `verify-api.js` 改為 dual-mode (standalone + plugin) | R33 | `01-foundation.md` |
| `checkAndInject` 空 todos 時 return 不 inject | R34 | `04-ux-integration.md` |
| 實作 `loadFromPersistence` + `loadAllFromPersistence` | R35 | `02-state-monitoring.md` |

### 實作時需確認的決策

| 決策 | 關聯 | 決定 | 狀態 |
|------|------|------|------|
| `TOOL_TIMEOUTS` 是否從 config 讀取？ | H1 / I1 | 是 — `handleToolStarted(state, event, config)` 讀取 `config.toolTimeout` | 🔧 已修復 |
| `MAX_SESSIONS` 是否可被 config 覆蓋？ | H3 | 是 — 新增 `config.maxSessions` 欄位 | 📌 待實作 |
| `cleanupAgeHours` 是否要 runtime 可調？ | H2 | 否 — hardcoded 24h 可接受 | 📌 保留 |
| `styleAware` 欄位是否保留？ | V2, S2 | 否 — 移除未使用的欄位 | 📌 待移除 |
| `event.properties?.tool` 是否有效？ | V1 | 待 verify-api.js 第 2 項確認後決定 | 🔧 已加註 |
| `updateContextPressure` 的單位？ | V3 | 2000 **tokens** (與 estimateContextTokens 一致) | 📌 待加註 |
| `previousTodosForSession` 清理策略？ | V6 | 在 `removeState` 時一併 `delete` | 📌 待實作 |
| 是否新增 `todowrite`/`memory` 等 tool 的 type suggestion？ | I3 | 是 — 已補上 8 種工具建議 | 🔧 已修復 |

---

## 追蹤狀態表

此 review 發布後，`_plan-fixes` 階段的修正已處理部分 finding。以下為完整追蹤：

| Finding | 類型 | 狀態 | 處理方式 |
|---------|------|------|---------|
| R1 mock.js 遞迴 bug | 🔴 Bug | 🔧 已修復於 `01-foundation.md` Task 1.12 | 改用完整自製 timer queue |
| R2 mock timer 無法控制時間 | 🔴 Bug | 🔧 已修復於 `01-foundation.md` Task 1.12 | 使用完整自製 timer queue，不依賴真實 setTimeout |
| R3 promptType 未定義 | 🔴 Bug | 🔧 已修復於 `03-recovery-response.md` Task 3.12 | `buildInjectPrompt` 回傳 `{ prompt, promptType }` |
| R4 death spiral test 錯置 | 🔴 Bug | ⏳ 待驗證 — `03-recovery-response.md` tests 已用正確資料結構 | 確認 `truncationEvents` 而非 `toolCallHistory` |
| R5 checkStuckState 缺參數 | 🔴 Bug | 🔧 已修復於 `03-recovery-response.md` Task 3.9 | 補上 `config` 參數 |
| R6 debounce timer 不受 cleanup | 🔴 Bug | 🔧 已修復於 `04-ux-integration.md` Task 4.1 | `persistAllStates` 使用 `immediatePersist` 跳過 debounce |
| R7 recovery verification 遺失 | 🟡 設計漏洞 | 🔧 已修復於 `04-ux-integration.md` Task 4.1 + `03-recovery-response.md` Task 3.1 | index.js 補上 tool.started handler + detectTruncation 整合 |
| R8 shouldSkipInjection 邏輯 | 🟡 設計漏洞 | ⚠️ 可能過時 — `04-ux-integration.md` 中已為 `return false` | 確認現有行為正確 |
| R9 processingGuard timeout | 🟡 設計漏洞 | 🔧 已修復於 `04-ux-integration.md` Task 4.5 | `checkAndInject` 加入 guard timeout force-release |
| R10 persistAllStates 不回寫 | 🟡 設計漏洞 | 🔧 已修復於 `04-ux-integration.md` Task 4.1 | 改為 `immediatePersist` 跳過 debounce |
| R11 exchangeCount 重複計數 | 🟡 設計漏洞 | 🔧 已修復於 `02-state-monitoring.md` Task 2.6 | 加入去重機制 |
| R12 event property adapter | 🔵 文件 | 🔧 已修復於 `02-state-monitoring.md` Task 2.9 + `04-ux-integration.md` Task 4.1 | 加入 `getSessionID()` 多來源適配 |
| R13 state shape 分類 | 🔵 文件 | 📌 保留設計 doc 原始分類 | 非功能性問題 |
| R14 states 無法被測試存取 | 🔵 文件 | 🔧 已修復於 `02-state-monitoring.md` Task 2.3 | 加入 `getStatesMap()` accessor |
| R15 log prefix 未使用 | 🔵 文件 | 📌 保留 — `[TOOL_ERR]` 改為 `[WARN]` 統一前綴 | log 格式統一是設計選擇 |
| R16 archive 無 changelog | 🔵 文件 | 🔧 已修復 | 建立 `_archive/README.md` |
| R17 gate 數字不一致 | 🔵 文件 | 🔧 已修復於多個檔案 | 統一為 104 (21+24+40+10+9) |
| R18 Node.js test runner | 🔵 文件 | 📌 保留 — `node --test task/` 支援 `task/*.test.js` | 路徑已修正為 `.opencode/plugins/.../test/` |
| R19 self circuit breaker | ⚪ 建議 | 📌 待 Phase 2 評估 | 未納入本次修正範圍 |
| R20 concurrency guard | ⚪ 建議 | 📌 待評估 | 可在實作 `checkAndInject` 時加入 |
| R21 mixtral-8x7b scale 誤判 | ⚪ 建議 | 🔧 已修復於 `01-foundation.md` Task 1.2 | 加入 MoE 模式跳過邏輯 |
| R22 sanitizeSessionID collision | ⚪ 建議 | 📌 待評估 | 可在實作 `utils.js` 時加入 hash suffix |
| R23 processingGuard timeout | ⚪ 建議 | 🔧 已修復（同 R9） | 合併處理 |
| R24 buildTypeSuggestion 未定義 | ⚪ 建議 | 🔧 已修復於 `03-recovery-response.md` Task 3.10 | 在 injector.js 中加入定義 |
| R25 verify-api.js 執行方式 | ⚪ 建議 | 📌 保留 — 需人類執行確認 | plugin 格式不可自動化 |
| R26 makeLogger 預設值一致 | ⚪ 建議 | 🔧 已修復 | 改為 lazy init + getLogger() 模式 |
| R27 node:test 模組策略 | ⚪ 建議 | 📌 保留 — 依實際環境決定 | 無法預測使用者專案的 package.json type |
| R28 測試行數低估 | ⚪ 建議 | 📌 保留 — 實作時自然調整 | 行數估計僅供參考 |
| R29 buildFullRecoveryPrompt 未定義 | 🔴 Bug | 🔧 已修復於 `03-recovery-response.md` Task 3.10 | 新增 `buildFullRecoveryPrompt(todos, state, promptStyle)` 完整 todo 注入 |
| R30 shouldAttemptRecovery 雙重注入 | 🟡 設計漏洞 | 🔧 已修復於 `03-recovery-response.md` Task 3.1 | 加入 `recoveryState !== 'idle'` guard，測試 26→27 |
| R31 log 前綴不一致 | 🔵 文件 | 🔧 已修復於 `2026-05-13-heartbeat-local-llm.md` §Log 策略 | 擴充 prefix 表至 17 項含 module 欄 |
| R32 buildPersistData 不完整 | 🟡 設計漏洞 | 🔧 已修復於 `02-state-monitoring.md` Task 2.2 | v2 格式含 recoveryState/deathSpiral/truncationEvents |
| R33 verify-api.js 執行矛盾 | 🔵 文件 | 🔧 已修復於 `01-foundation.md` Task 1.11 | 改 dual-mode (standalone + plugin) 含實作範例 |
| R34 空 todos 混淆 prompt | ⚪ 邊界 | 🔧 已修復於 `04-ux-integration.md` Task 4.5 | 空 todos 時 return 跳過 injectContinuation |
| R35 loadFromPersistence 完全缺失 | 🔴 Bug | 🔧 已修復於 `02-state-monitoring.md` Task 2.3b | 完整實作 + inflateStateFromPersist + test |
| I1 TOOL_TIMEOUTS 與 config.toolTimeout 重複 | 🔵 文件 | 🔧 已修復於 `02-state-monitoring.md` Task 2.4 | `handleToolStarted` 接受 config 參數，優先讀取 `config.toolTimeout` (秒→ms) |
| I2 handleUserCommand/handleUserMessage 簽名不一致 | 🔵 文件 | 🔧 已修復於 `2026-05-13-heartbeat-local-llm.md` §2d | 標註 Phase 4 為 canonical，參數順序為 `(state, text, sessionID)` |
| I3 buildTypeSuggestion 缺少工具類型 | 🔵 文件 | 🔧 已修復於 `03-recovery-response.md` Task 3.10 | 補上 todowrite/memory/question/search/websearch 等 8 種工具建議 |
| V1 event.properties?.tool 未驗證 | ⚪ 建議 | 🔧 已修復於 `02-state-monitoring.md` Task 2.4 | 加註說明需 verify-api.js 第 2 項確認 |
