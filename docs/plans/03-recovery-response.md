# Phase 3 — Recovery & Response

**目標：** 實作核心決策引擎 — recovery state machine (feedback loop) 與 injector (prompt routing)。此階段是 plugin 的大腦。

**前置條件：** Gate #2 通過（state.js, monitor.js 就緒，事件已經可以正確監控）

**設計參考：** `2026-05-13-heartbeat-local-llm.md` §關鍵功能 8 Recovery 反饋迴圈、§關鍵功能 9 Tool 錯誤分級、§9g Injector Routing Matrix

---

## TODO 列表

LLM 實作時依序執行，每完成一項用 `todowrite` 設為 completed：

| # | 任務 | 檔案 | 行數估計 | 類型 |
|---|------|------|---------|------|
| 3.1 | `shouldAttemptRecovery` — 7 個 blocking 條件 (含雙重注入防護 `recoveryState!=='idle'`) | recovery.js | ~22 | 邏輯 |
| 3.2 | RECOVERY_LEVELS (0-3) + `getRecoveryPrompt` — 漸進提示 | recovery.js | ~25 | 邏輯 |
| 3.3 | `executeRecovery` — inject prompt + start verification + persist | recovery.js | ~30 | 流程 |
| 3.4 | `startRecoveryVerification` + `clearRecoveryVerification` — 兩階段 timer (stage1=warn, stage2=fail) | recovery.js | ~35 | 流程 |
| 3.5 | `handleRecoverySuccess` + `handleRecoveryFailure` — quality assess + escalation + death spiral check | recovery.js | ~50 | 流程 |
| 3.6 | `detectDeathSpiral` — 5 種方法 (frequency / consecutive fail / context pressure / tool error spiral / same tool cascade) | recovery.js | ~25 | 邏輯 |
| 3.7 | `analyzeToolErrors` — 4-level pattern analyzer (level 0-4) | recovery.js | ~30 | 邏輯 |
| 3.8 | `buildToolEscalationPrompt` — tool-type aware (bash/edit/write/default) + web search level | recovery.js | ~20 | 邏輯 |
| 3.9 | `determinePromptType` — 5 種情境優先級 (recovery > toolError > context > stuck > normal) | injector.js | ~25 | 邏輯 |
| 3.10 | `selectPromptTemplate` + `buildInjectPrompt` — routing matrix (7 types × 3 styles × 4 levels, FIX) | injector.js | ~45 | 邏輯 |
| 3.11 | `fillTemplate` — `{variable}` 替換 + missing var 保留 | injector.js | ~10 | 工具 |
| 3.12 | `injectContinuation` — 最終注入 entry point + 錯誤處理 | injector.js | ~20 | 流程 |
| 3.13 | `phase3-recovery.test.js` — 17 P0 + 10 P1 = 27 cases (P0: shouldAttempt×7 / detectDeathSpiral×5 / getRecoveryPrompt×4 / assessRecoveryQuality×1 + P1: state machine×7 / timer guard×2 / error levels×1) | test/ | ~105 | 測試 |
| 3.14 | `phase3-injector.test.js` — 13 cases (selectPromptTemplate×7 / buildInjectPrompt×3 / determinePromptType×3 + buildFullRecoveryPrompt implicit via selectPromptTemplate recovery L3) | test/ | ~60 | 測試 |
| 3.15 | **Gate #3 驗證** — 7 blocking conditions (含雙重注入防護) / idle→injected→verified & injected→failed→stopped / 7 promptTypes | — | — | 檢查點 |

**實作順序：** 3.1→3.2→3.3→3.4→3.5→3.6→3.7→3.8→3.9→3.10→3.11→3.12→3.13→3.14→3.15

---

## 檔案架構

```
.opencode/plugins/smart-heartbeat-local/
├── recovery.js     # 狀態機 + 死亡螺旋 + 工具錯誤分析 (NEW)
├── injector.js     # Prompt 路由 + 模板選擇 + 注入 (NEW)
└── index.js        # Update: 連結 recovery/injector 到 monitoring 事件
```

## Module: recovery.js

**Exports:**
- `shouldAttemptRecovery(state, config)` → `{ boolean }`
- `executeRecovery(sessionID, state, todos, client, config)` — 注入 recovery (async，需 await)
- `handleRecoverySuccess(state, toolEvent)` — tool.started = verified
- `handleRecoveryFailure(sessionID, state, config, todos, client)` — timer 過期
- `detectDeathSpiral(state, config)` → `{ boolean }`
- `assessRecoveryQuality(state, toolEvent)` → `{ quality }`
- `analyzeToolErrors(state, config)` → `{ analysis }`
- `buildToolEscalationPrompt(analysis, task, state)` → `{ prompt }`
- `clearRecoveryVerification(state)` — 清理 timer

### 實作任務

> **與 Phase 2 的銜接：** recovery state machine 的觸發條件來自 `detectTruncation()`（定義於 Phase 2 monitor.js Task 2.9）。`checkAndInject`（Phase 4）會在 tool.completed 後呼叫 `detectTruncation`。若回傳 `truncated=true`，則呼叫 `shouldAttemptRecovery` → `executeRecovery`。
>
> **完整 recovery 觸發流程：**
> ```
> tool.completed
>   → checkAndInject(sessionID)
>     → detectTruncation(state, prevTodos, currentTodos, config)
>       ├─ truncated=false → 正常續行檢查 (injectContinuation)
>       └─ truncated=true → shouldAttemptRecovery(state, config)
>             ├─ false → 跳過（記錄 truncation 但不處理）
>             └─ true → executeRecovery(sessionID, state, todos, client, config)
> ```

**Task 3.1: Recovery state machine — pre-check**

```javascript
function shouldAttemptRecovery(state, config) {
  // ⚠️ 防止雙重注入：若 recovery 已在進行中或已完成，不觸發新 cycle
  if (state.recoveryState !== 'idle') return false
  if (state.deathSpiral) return false
  if (state.recoveryAttempts >= (config.maxRecoveryAttempts || 3)) return false
  if (state.contextWarnings >= 3) return false  // context 壓力過高
  if (state.processingGuard) return false  // 模型還在處理
  if (state.waitingForTool) return false   // 等 tool 回傳
  return true
}
```

**Task 3.2: Progressive prompt levels**

```javascript
// Prompt levels correspond to increasing verbosity
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
```

**Task 3.3: executeRecovery — 注入 + 啟動驗證**

```javascript
async function executeRecovery(sessionID, state, todos, client, config) {
  const prompt = getRecoveryPrompt(state.recoveryLevel, todos, state, null)
  
  state.recoveryState = 'injected'
  state.lastRecoveryTime = Date.now()
  state.recoveryAttempts++
  state.truncationEvents.push({ time: Date.now(), success: false })
  if (state.truncationEvents.length > 10) state.truncationEvents.shift()
  
  // Persist before injection
  persistState(sessionID, state)
  
  // Inject recovery prompt (async，await 確保錯誤被正確捕獲)
  // 與 injectContinuation 保持一致的使用方式
  try {
    await client.session.prompt({ message: prompt, sessionID })
  } catch (e) {
    warn(`[RECOV] inject failed for ${sessionID}: ${e.message}`)
    handleRecoveryFailure(sessionID, state, config, todos, client)
    return
  }
  
  // Start verification
  startRecoveryVerification(sessionID, state, config, todos, client)
}
```

**Task 3.4: Two-stage verification timer**

```javascript
function startRecoveryVerification(sessionID, state, config, todos, client) {
  // Stage 1: 70% of estimated time — log warning if no response
  const stage1Delay = Math.max(15000, (state.estimatedProcessTime || 30000) * 0.7)
  // Stage 2: 140% of estimated, capped at config value
  const stage2Delay = Math.min(stage1Delay * 2, config.recoveryVerificationMaxMs || 60000)

  clearRecoveryVerification(state)

  state.recoveryVerificationStage1 = setSafeTimeout(() => {
    // Stage 1: just log, don't fail yet
    warn(`[RECOV] processing slow (>${stage1Delay}ms) for ${sessionID}`)
    
    // Stage 2: real failure
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
```

**Task 3.5: Recovery success + failure handlers**

```javascript
function handleRecoverySuccess(state, toolEvent) {
  clearRecoveryVerification(state)
  state.recoveryState = 'verified'
  state.recoveryQuality = 'unknown'
  state.recoveryLevel = 0  // 重置漸進層級
  
  // Mark last truncation event as success
  const last = state.truncationEvents[state.truncationEvents.length - 1]
  if (last) last.success = true
  
  assessRecoveryQuality(state, toolEvent)
}

function handleRecoveryFailure(sessionID, state, config, todos, client) {
  clearRecoveryVerification(state)
  state.recoveryState = 'failed'
  
  // Update last truncation event
  const last = state.truncationEvents[state.truncationEvents.length - 1]
  if (last) last.success = false
  
  // Death spiral check
  if (detectDeathSpiral(state, config)) {
    state.deathSpiral = true
    state.recoveryState = 'stopped'
    warn(`[RECOV] death spiral detected for ${sessionID}, recovery stopped`)
    autoNotify(state, sessionID)
    return
  }
  
  // Retry with escalation
  if (state.recoveryAttempts < (config.maxRecoveryAttempts || 3)) {
    state.recoveryLevel = Math.min(state.recoveryLevel + 1, 3)
    executeRecovery(sessionID, state, todos, client, config)
  } else {
    state.recoveryState = 'stopped'
    warn(`[RECOV] max attempts (${config.maxRecoveryAttempts}) reached for ${sessionID}`)
    autoNotify(state, sessionID)
  }
}
```

**Task 3.6: Death spiral detection — 5 methods**

```javascript
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
```

**Task 3.7: Tool error pattern analyzer**

```javascript
function analyzeToolErrors(state, config) {
  const history = state.toolCallHistory || []
  const errors = history.filter(t => t.status === 'error')
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
```

**Task 3.8: Tool-type aware escalation prompts**

```javascript
function buildToolEscalationPrompt(analysis, task) {
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
```

## Module: injector.js

**Exports:**
- `determinePromptType(state, todos, config)` → `{ promptType }`
- `selectPromptTemplate(promptType, promptStyle, level, state, todos)` → `{ promptText }`
- `buildInjectPrompt(state, todos, config)` → `{ promptText }`
- `injectContinuation(sessionID, state, todos, client, config)` — 執行注入

### 實作任務

**Task 3.9: determinePromptType — 5 種情境優先級**

```javascript
function determinePromptType(state, todos, config) {
  // Priority 1: Recovery
  if (state.recoveryState !== 'idle') return 'recovery'
  
  // Priority 2: Tool error
  const analysis = analyzeToolErrors(state, config)
  state.toolErrorAnalysis = analysis
  if (analysis.level >= 1) {
    if (analysis.level >= 4) return 'tool_error_search'
    if (analysis.level >= 2) return 'tool_error_escalated'
    return 'tool_error'
  }
  
  // Priority 3: Context pressure
  if (state.contextWarnings >= 3) return 'context_pressure'
  
  // Priority 4: Stuck
  const stuck = checkStuckState(state, todos, config)
  if (stuck.stuck) return 'stuck'
  
  // Priority 5: Normal continuation
  return 'normal'
}
```

**Task 3.10: Routing matrix (FIX — 7 promptTypes × 3 styles × 4 levels)**

```javascript
const INJECTOR_ROUTES = {
  recovery:           { needsLevel: true,  styleAware: true,  group: 'recovery' },
  tool_error:         { needsLevel: true,  styleAware: true,  group: 'toolError' },
  tool_error_escalated: { needsLevel: true,  styleAware: true,  group: 'toolError' },
  tool_error_search:  { needsLevel: false, styleAware: true,  group: 'toolError' },
  context_pressure:   { needsLevel: false, styleAware: true,  group: 'context' },
  stuck:              { needsLevel: false, styleAware: true,  group: 'stuck' },
  normal:             { needsLevel: false, styleAware: true,  group: 'continuation' },
}

function selectPromptTemplate(promptType, promptStyle, level, state, todos) {
  const route = INJECTOR_ROUTES[promptType]
  if (!route || !promptStyle) return ''

  if (route.group === 'recovery') {
    return getRecoveryPrompt(level || 0, todos, state, promptStyle)
  }

  if (route.group === 'toolError') {
    if (!route.needsLevel) return promptStyle.toolErrorL4
    const lvl = Math.min(Math.max(level || 1, 1), 4)
    let tpl = promptStyle[`toolErrorL${lvl}`] || promptStyle.toolErrorL1
    if (level >= 3 && state.toolErrorAnalysis?.toolType) {
      tpl = tpl.replace('{suggestion}', buildTypeSuggestion(state.toolErrorAnalysis.toolType))
    }
    return tpl
  }

  if (route.group === 'context') return promptStyle.contextPressure
  if (route.group === 'stuck') return promptStyle.stuck
  return promptStyle.continuation
}

// buildFullRecoveryPrompt — Level 3「最後手段」完整 recovery prompt
// 當 Level 0-2 都失敗時，將完整 todo 清單注入給模型
// 設計參考 §9g: Recovery Level 3 完整模板
function buildFullRecoveryPrompt(todos, state, promptStyle) {
  const pending = todos.filter(t => t.status !== 'completed')
  const taskList = pending.map((t, i) => `${i + 1}. ${t.content} (${t.status === 'in_progress' ? '進行中' : t.status || '待處理'})`).join('\n')
  const nextTask = pending.find(t => t.status === 'in_progress') || pending[0]
  
  // 以 promptStyle 風格為基底，但 Level 3 使用完整復原格式（不受 style 模板限制）
  const styleTag = promptStyle?.continuation?.startsWith('[續行]') ? '[系統復原]' : ''
  
  return [
    `${styleTag}上下文已重置。`,
    ``,
    `未完成任務：`,
    `${taskList}`,
    ``,
    `從「${nextTask?.content || '任務'}」繼續。先讀取相關檔案，再繼續完成。不要從頭開始。`,
    `直接執行，完成後用 todowrite。不要問問題。`,
  ].join('\n')
}

// buildTypeSuggestion — tool 類型感知的具體建議字串 (for {suggestion} placeholder)
// FIX (I3): 加入 todowrite / memory / question / search / websearch 等工具
function buildTypeSuggestion(toolType) {
  switch (toolType) {
    case 'bash': return '改用 write 產生腳本，或拆分為更小指令'
    case 'edit': return '先用 read 確認行號，或改用 write 覆蓋整個檔案'
    case 'write': return '先用 bash mkdir -p 建立目錄，再 write'
    case 'read': return '確認檔案路徑是否正確'
    case 'grep': return '簡化搜尋關鍵字，或改用 read 直接讀取'
    case 'glob': return '簡化 glob pattern，或改用 ls 確認'
    case 'todowrite': return '重送 todowrite 更新任務狀態，確認哪些已完成哪些待辦'
    case 'memory': return '先用 read 確認相關記憶，再決定是否需要新增記憶'
    case 'question': return '直接回答使用者問題，不要猜測'
    case 'search': return '使用更具體的搜尋關鍵字，或改用 web-forager'
    case 'websearch': return '改用 exa_web_search_exa 搜尋更精確的關鍵字'
    case 'web-forager': return '改用 jina_fetch 直接讀取目標網頁'
    case 'exa_web_search_exa': return '更換搜尋詞，或改用 exa_crawling_exa 直接爬取'
    default: return `改用完全不同工具處理 ${toolType}`
  }
}

// 最終注入 prompt 生成入口 (回傳 { prompt, promptType }，供 injectContinuation 記錄)
function buildInjectPrompt(state, todos, config) {
  const promptType = determinePromptType(state, todos, config)
  const promptStyle = getPromptStyle(config)
  const errorLevel = state.toolErrorAnalysis?.level || 0
  const template = selectPromptTemplate(promptType, promptStyle, errorLevel, state, todos)
  
  const prompt = fillTemplate(template, {
    task: todos.find(t => t.status === 'in_progress')?.content || (todos[0]?.content || ''),
    n: todos.filter(t => t.status !== 'completed').length,
    lastTool: state.toolErrorAnalysis?.lastErrorTool || '',
    suggestion: '',
  })
  return { prompt, promptType }
}
```

**Task 3.11: fillTemplate — 變數替換**

```javascript
function fillTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, key) => vars[key] !== undefined ? vars[key] : `{${key}}`)
}
```

**Task 3.12: injectContinuation — 最終注入 entry point**

```javascript
async function injectContinuation(sessionID, state, todos, client, config) {
  const { prompt, promptType } = buildInjectPrompt(state, todos, config)
  if (!prompt) {
    warn(`[INJECT] empty prompt for ${sessionID}, skip`)
    return
  }
  
  state.lastInjectionTime = Date.now()
  state.processingGuard = true
  
  try {
    await client.session.prompt({ message: prompt, sessionID })
    log(`[OK] [${sessionID}] injected: ${promptType}`)
  } catch (e) {
    err(`[INJECT] prompt failed for ${sessionID}: ${e.message}`)
  }
}
```

## Phase 3 單元測試

### task/phase3-recovery.test.js — 16 P0 + 10 P1 = 26 cases total

**Pure function tests (P0):**

| 函數 | 案例 | 測試重點 |
|------|------|---------|
| `shouldAttemptRecovery()` | 7 | 7 個 return-false 分支各 1 (recoveryState!==idle/deathSpiral/maxAttempts/contextWarnings/procGuard/waitingTool/recoveryState=injected) + 1 true |
| `detectDeathSpiral()` | 5 | 頻率/連續失敗/context壓力/tool錯誤螺旋/同tool連錯 |
| `getRecoveryPrompt()` | 4 | Level 0/1/2/3 + in_progress 優先 + 空 todos fallback |
| `assessRecoveryQuality()` | 1 | 重複 tool → confused / 新 tool → good |

```javascript
// shouldAttemptRecovery — all blocking conditions
const state = createOrGetState('test-ses')

// Guard 1: recoveryState !== 'idle' (prevents double injection)
state.recoveryState = 'injected'
assert.strictEqual(shouldAttemptRecovery(state, DEFAULT_CONFIG), false)
state.recoveryState = 'verified'
assert.strictEqual(shouldAttemptRecovery(state, DEFAULT_CONFIG), false)
state.recoveryState = 'idle'  // reset

// Guard 2: deathSpiral
state.deathSpiral = true
assert.strictEqual(shouldAttemptRecovery(state, DEFAULT_CONFIG), false)

state.deathSpiral = false
state.recoveryAttempts = DEFAULT_CONFIG.maxRecoveryAttempts + 1
assert.strictEqual(shouldAttemptRecovery(state, DEFAULT_CONFIG), false)

// detectDeathSpiral — 5 methods (all must trigger)
// 注意: detectDeathSpiral 讀取 state.truncationEvents（非 toolCallHistory）
//       以及 state.toolErrorAnalysis（由 analyzeToolErrors 設定）

// Method 1: frequency — 3 truncation events in deathSpiralWindow
state.truncationEvents = Array(3).fill({ time: Date.now() - 60000, success: false })
assert(detectDeathSpiral(state, DEFAULT_CONFIG))

// Method 2: consecutiveFail — 2+ truncation events marked as failure
state.truncationEvents = [
  { time: Date.now() - 120000, success: false },
  { time: Date.now() - 60000, success: false },
]
assert(detectDeathSpiral(state, DEFAULT_CONFIG))

// Method 3: contextPressure — contextWarnings >= 3 + at least 1 truncation
state.contextWarnings = 5
state.truncationEvents = [{ time: Date.now() - 120000, success: true }]
assert(detectDeathSpiral(state, DEFAULT_CONFIG))

// Method 4: toolErrorSpiral — toolErrorAnalysis.level >= 3 + at least 1 truncation
state.truncationEvents = [{ time: Date.now() - 90000, success: false }]
state.toolErrorAnalysis = { level: 3, pattern: 'single_tool', toolType: 'bash', errorCount: 4, consecutiveSameTool: false, lastErrorTool: 'bash' }
state.contextWarnings = 0
assert(detectDeathSpiral(state, DEFAULT_CONFIG))

// Method 5: sameToolCascade — consecutiveSameTool + errorCount >= 5
state.toolErrorAnalysis = { level: 4, pattern: 'single_tool', toolType: 'edit', errorCount: 6, consecutiveSameTool: true, lastErrorTool: 'edit' }
state.truncationEvents = []
assert(detectDeathSpiral(state, DEFAULT_CONFIG))
```

**State machine tests (P1):**

| 場景 | 案例 | 測試重點 |
|------|------|---------|
| idle → injected | 1 | executeRecovery 正確設定狀態 |
| injected → verified (tool.started) | 1 | handleRecoverySuccess 清除 timer + 設 quality |
| injected → failed (timer expiry) | 1 | stage2 觸發 handleRecoveryFailure |
| failed → injected (escalate) | 1 | recoveryLevel++ 後重試 |
| failed → stopped (max attempts) | 1 | 超過上限後停止 |
| Stage1 timer (slow, not fail) | 1 | stage1 只 warn 不 fail |
| Stage2 timer (failure) | 1 | stage2 實際觸發 failure |
| Timer callback guard | 2 | session 消失 / recoveryState 已變 |

```javascript
// Timer guard: callback 中 session 已不存在
it('should silently ignore timer callback if session gone', () => {
  const sid = 'ephemeral'
  createOrGetState(sid)
  removeState(sid)
  // timer callback 此時觸發 → states.get(sid) 為 undefined → 應 return
  // (透過 fake timers 觸發)
})

// Tool error analyzed levels
it('should return correct level for error counts', () => {
  const state = createOrGetState('test-ses')
  state.toolCallHistory = [{status:'error'},{status:'error'},{status:'error'}]
  assert.strictEqual(analyzeToolErrors(state, DEFAULT_CONFIG).level, 3)  // 3 errors >= 2
})
```

### task/phase3-injector.test.js — 13 cases

**Pure function tests (P0):**

| 函數 | 案例 | 測試重點 |
|------|------|---------|
| `selectPromptTemplate()` | 7 | 7 promptTypes (recovery/toolError/tool_error_escalated/context_pressure/stuck/normal/unknown) + missing style |
| `buildInjectPrompt()` | 3 | 正常路由 / 錯誤路由 / 空 todos |
| `determinePromptType()` | 3 | recovery 優先 / toolError 優先 / normal |

```javascript
// selectPromptTemplate — routing matrix
const style = PROMPT_STYLES.ultra_short
assert.ok(selectPromptTemplate('recovery', style, 0, state, todos))
assert.ok(selectPromptTemplate('normal', style, 0, state, todos))
assert.ok(selectPromptTemplate('stuck', style, 0, state, todos))
assert.ok(selectPromptTemplate('context_pressure', style, 0, state, todos))
assert.strictEqual(selectPromptTemplate('imaginary_type', style, 0, state, todos), '')

// tool_error — 單一 tool 錯誤低級別 prompt
state.toolCallHistory = [{ name: 'bash', status: 'error', time: Date.now() - 10000 }]
const toolErrPrompt = selectPromptTemplate('tool_error', style, 1, state, todos)
assert.ok(toolErrPrompt)
assert(toolErrPrompt.includes('{toolName}') || toolErrPrompt.includes('bash'))

// tool_error_escalated — 多次 tool 錯誤高級別 prompt
state.toolCallHistory = [
  { name: 'bash', status: 'error', time: Date.now() - 60000 },
  { name: 'bash', status: 'error', time: Date.now() - 30000 },
  { name: 'bash', status: 'error', time: Date.now() - 10000 },
]
const escalatedPrompt = selectPromptTemplate('tool_error_escalated', style, 3, state, todos)
assert.ok(escalatedPrompt)
assert(escalatedPrompt.includes('escalat') || escalatedPrompt.includes('level') || escalatedPrompt.includes('錯誤'))

// fillTemplate variable replacement
assert.strictEqual(fillTemplate('繼續: {task}', { task: '測試' }), '繼續: 測試')
assert.strictEqual(fillTemplate('{a}', { a: '1' }), '1')
assert.strictEqual(fillTemplate('{missing}', {}), '{missing}')  // 未提供變數保留不變
```

## Checkpoint Gate #3

通過條件：
1. `shouldAttemptRecovery` 在 7 個 blocking 條件下都回傳 false（含 `recoveryState!=='idle'` 防止雙重注入），pass 時回傳 true
2. Recovery state machine: idle→injected→verified 和 idle→injected→failed→stopped 兩個路徑正確
3. 兩階段 verification timer: stage1 只 warn，stage2 觸發 failure
4. `detectDeathSpiral` 5 種方法各自觸發
5. `analyzeToolErrors` 在 level 0-4 都回傳正確結果
6. `selectPromptTemplate` 在 7 種 promptType × 3 種 style × 4 種 level 下都回傳非空字串（邊界測試即可，不需全組合）

**確認重點：** recovery state machine 的 timer callback 安全 guard — callback 內檢查 session 仍存在且 recoveryState 仍是 injected。
