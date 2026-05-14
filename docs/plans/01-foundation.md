# Phase 1 — Foundation

**目標：** 建立 plugin 的基礎設施層，包含 config schema、工具函數、安全強化、以及 plugin lifecycle。此階段不依賴任何 runtime 事件。

**前置條件：** 無（但第 1.11 項 `verify-api.js` 必須在 Phase 1 所有其他實作之前先執行，以確認 4 個 API 行為。若 API 行為與設計假設不符，可能需要 redesign。）

**設計參考：** `2026-05-13-heartbeat-local-llm.md` §安全與強化、§設定檔結構、§Config Validation、§Model Profile 系統

---

## TODO 列表

LLM 實作時依序執行，每完成一項用 `todowrite` 設為 completed：

| # | 任務 | 檔案 | 行數估計 | 類型 |
|---|------|------|---------|------|
| 1.1 | DEFAULT_CONFIG schema — 23 個參數預設值 | config.js | ~40 | 結構 |
| 1.2 | MODEL_SCALE_TIERS (2 級) + `detectModelScale` + `parseParamCountFromModelName` + `detectModelProfile` | config.js | ~50 | 邏輯 |
| 1.3 | `loadConfig` — default ← profile ← custom ← override merge | config.js | ~30 | 邏輯 |
| 1.4 | `validateConfig` — type check + range check + logLevel enum | config.js | ~30 | 邏輯 |
| 1.5 | `getPromptStyle` — ultra_short / short 兩種 style | config.js | ~55 | 資料 |
| 1.6 | `sanitizeSessionID` — 特殊字元取代 + non-string fallback | utils.js | ~10 | 安全 |
| 1.7 | `estimateContextTokens(FIX)` + `estimateProcessTime` — exchangeCount 獨立計算 | utils.js | ~25 | 邏輯 |
| 1.8 | `makeLogger` — 三級 logger (debug/warn/err) | utils.js | ~15 | 工具 |
| 1.9 | `setSafeTimeout` + `clearAllTimers` + `isWakeAfterSleep` — macOS sleep guard (callback 包 try/catch) | utils.js | ~30 | 安全 |
| 1.10 | `deepMerge` — plain object 合併 | utils.js | ~15 | 工具 |
| 1.10b | `readTodos` + `readTodosFromPersistence` — 三層 todo 讀取適配層 (NEW) | utils.js | ~25 | 工具 |
| 1.11 | `verify-api.js` — 4+1 個未知 API 行為驗證 plugin（含第 5 項 todo 讀取 API, NEW）（**Phase 1 第一步先做這個**） | verify-api.js | ~55 | 驗證 |
| 1.12 | `mock.js` — mock infrastructure: mockOpencode, mockClient, mockEvent, fake timers helper | test/ | ~60 | 基礎設施 |
| 1.13 | `phase1-config.test.js` — 10 個測試案例 (validateConfig×4 / detectModelProfile×2 / detectModelScale×2 / parseParamCount×1 / getPromptStyle×1) | test/ | ~60 | 測試 |
| 1.14 | `phase1-utils.test.js` — 11 個測試案例 (sanitize×3 / estimateContext×5 / estimateProcessTime×2 / isWakeAfterSleep×1) | test/ | ~60 | 測試 |
| 1.15 | **Gate #1 驗證** — `node -c config.js && node -c utils.js` + verify-api.js 已執行（含第 5 項 todo API 結果） | — | — | 檢查點 |

**實作順序：** 1.11→1.1→1.2→1.3→1.4→1.5→1.6→1.7→1.8→1.9→1.10→1.10b→1.12→1.13→1.14→1.15

> Phase 1 測試總數: config 10 + utils 11 = **21 cases**（此為 Phase 1 專屬測試。全部 Phase 1-5 共 104 cases。）

---

## 檔案架構

```
.opencode/plugins/smart-heartbeat-local/
├── config.js       # 設定 schema + 驗證 + model profiles (NEW)
├── utils.js        # 工具函數 (NEW)
└── verify-api.js   # API 驗證 plugin (NEW, 獨立執行)
```

## Module: config.js

**Exports:**
- `loadConfig(opencode)` → `{ validatedConfig }` — 從 opencode.json 載入並合併
- `validateConfig(raw)` → `{ errors[], config }` — type/range 驗證，有錯誤時用全預設
- `detectModelProfile(opencode)` → `{ scaleTier }` — auto-detect 或 fallback (small|medium)
- `detectModelScale(modelName)` → `{ scaleTier|null }` — 從模型名稱解析參數量級 (NEW)
- `parseParamCountFromModelName(modelName)` → `{ scaleTier|null }` — 正則解析參數數值 (NEW)
- `getPromptStyle(config)` → `{ styleObject }`
- `DEFAULT_CONFIG` — 全預設值物件
- `MODEL_SCALE_TIERS` — 2 級內建設定 (small/medium)，取代硬編碼模型名 (NEW)

### 實作任務

**Task 1.1: Config schema + 23 個參數的預設值**

```javascript
// DESIGN REFERENCE: §設定檔結構
// 所有 threshold 在此定義，無任何 hardcoded 數值在 plugin code 中
const DEFAULT_CONFIG = {
  modelScale: 'auto',       // 'auto' | 'small' | 'medium' — 自動偵測或手動指定模型量級
  countdownSeconds: 30,
  minIntervalMs: 90000,
  maxStuckCycles: 8,
  maxToolErrors: 8,
  maxRepeatedTool: 10,
  maxIdleSeconds: 120,
  promptSpeedTps: 50,
  maxRecoveryAttempts: 3,
  recoveryVerificationMaxMs: 60000,
  deathSpiralWindowMs: 300000,
  deathSpiralThreshold: 3,
  logLevel: 'warn',
  effectiveMaxContext: 32000,
  toolTimeout: { task: 300, bash: 120, edit: 60, read: 30, default: 60 },
  persistence: { maxFiles: 100, cleanupAgeHours: 24, debounceMs: 5000 },
}
```

完整參數對照表請見設計參考 §設定檔結構。

**Task 1.2: Model Scale Tiers — 2 級設定 + auto-detect (取代硬編碼模型名稱)**

```javascript
// DESIGN REFERENCE: §Model Profile 系統 (已改採參數量級分級)
// 依模型參數量自動分級，不再硬編碼特定模型名稱。
// 任何未來模型只要名稱含參數數值 (e.g., "llama-4-12b", "phi-4-14b") 即可正確分級。
//
// 此 plugin 專為輔助中小型 local LLM 設計。
// 大型模型 (30B+) 無需此類輔助，故只設 small/medium 兩級。

// 二級設定量表：依模型規模調整 timeout、context 上限、提示風格
//
// 設計決策備註：
// - deathSpiralThreshold: small=3, medium=4。small 模型 context 較小，truncation 發生更快，
//   較低的 threshold 可更快觸發保護。medium 模型 context 較大，寬容度高。
// - DEFAULT_CONFIG 使用 small 值做最保守 fallback：auto-detect 失敗時用 small 參數，
//   所有模型都能正常運作（只是慢一點）。使用者可手動調快。
const MODEL_SCALE_TIERS = {
  'small': {    // < 10B params — e.g., Gemma-4 4B, Phi-4 7B, Llama-3.2 3B, Llama-3 8B
    promptSpeedTps: 50, effectiveMaxContext: 32000,
    countdownSeconds: 30, minIntervalMs: 90000,
    maxStuckCycles: 8, maxToolErrors: 8, maxRepeatedTool: 10,
    maxIdleSeconds: 120, maxRecoveryAttempts: 3,
    recoveryVerificationMaxMs: 60000, deathSpiralThreshold: 3,
    promptStyle: 'ultra_short',       // 極簡強勢 — 小模型理解力弱
  },
  'medium': {   // >= 10B params — e.g., Qwen3.5 14B, Mistral 12B, DeepSeek-Coder 16B, Llama-3.1 70B
    promptSpeedTps: 120, effectiveMaxContext: 64000,
    countdownSeconds: 20, minIntervalMs: 60000,
    maxStuckCycles: 5, maxToolErrors: 5, maxRepeatedTool: 8,
    maxIdleSeconds: 90, maxRecoveryAttempts: 2,
    recoveryVerificationMaxMs: 45000, deathSpiralThreshold: 4,
    promptStyle: 'short',             // 簡短明確 — 中型模型適中
  },
}

// 從模型名稱解析參數數量級
// 支援格式: "8b", "14b", "32b", "6.7b", "70b", "7b-v0.1", "Q4_K_M.gguf"
// 只區分 small(<10B) / medium(>=10B) 兩級
//
// ⚠️ Edge case: "mixtral-8x7b" — 跳過 MoE 模式的 "digit+x+digit" 格式
// (否則 "8" 會 match 到 "8b" → small，但實際 Mixtral 8x7B ≈ 47B)。
// 此類模型由 detectModelScale 的 family default (mixtral → medium) 處理。
function parseParamCountFromModelName(modelName) {
  if (typeof modelName !== 'string') return null
  // 跳過 "8x7b" 這類 MoE 模式 ("digit+x+digit+b")
  if (/\d+x\d+\s*b/i.test(modelName)) return null
  const match = modelName.match(/(\d+\.?\d*)\s*b/i)
  if (!match) return null
  const count = parseFloat(match[1])
  return (count < 10) ? 'small' : 'medium'
}

// 模型名稱 → 量級 — 從名稱推測所屬 tier
// 同時支援名稱內的參數數值與已知模型家族
// 只回傳 'small' 或 'medium'（此 plugin 不處理大型模型）
function detectModelScale(modelName) {
  if (typeof modelName !== 'string') return null

  // Priority 1: 正則解析參數數值 (最通用，適用任何品牌)
  const fromParam = parseParamCountFromModelName(modelName)
  if (fromParam) return fromParam

  // Priority 2: 已知模型家族預設值 (當名稱不含明確參數數值時)
  const lower = modelName.toLowerCase()
  if (lower.includes('gemma') || lower.includes('phi')) return 'small'
  // 以下家族預設為 medium（實際參數數值 >10B 時由 Priority 1 決定）
  if (lower.includes('llama')
    || lower.includes('mistral')
    || lower.includes('mixtral')
    || lower.includes('deepseek')
    || lower.includes('qwen')
    || lower.includes('yi')) return 'medium'

  return null  // 完全無法識別
}

// 主要入口：決定使用哪個 scale tier
// 優先順序: 使用者顯式設定 > auto-detect > fallback small
function detectModelProfile(opencode) {
  // 若有顯式設定且非 auto，直接採用
  const explicitScale = opencode?.config?.heartbeat?.modelScale
  if (explicitScale && explicitScale !== 'auto') {
    if (MODEL_SCALE_TIERS[explicitScale]) return explicitScale
  }

  // 自動偵測：從 session model name
  const modelName = opencode?.session?.model
    || opencode?.config?.model
    || process.env.OPENCODE_MODEL
  if (modelName) {
    const matched = detectModelScale(String(modelName))
    if (matched && MODEL_SCALE_TIERS[matched]) return matched
  }

  // Fallback: 最保守設定 (small)
  return 'small'
}
```

> **設計意圖：** 不再維護 `matchModelToProfile('gemma-4-4b')` 這種硬編碼映射。任何包含參數數值的模型名稱（`llama-4-12b`、`phi-4-14b`、`deepseek-v3-67b`）都自動落入正確量級。唯一需要更新 `detectModelScale` 的情況是：模型名稱不含參數數值且不屬已知家族。此時外掛者只要加一行 `if (lower.includes('new-model')) return 'medium'` 即可。
> **為何只有兩級：** 此 plugin 專為輔助中小型 local LLM 設計。大型模型（30B+）本身推理能力強、tool calling 可靠，不需要自動續行輔助。若使用者仍想在大型模型使用，auto-detect 會將其歸入 `medium` tier（採用保守但合理的參數）。

**Task 1.3: Config merge logic**

合併順序：`default → auto-detected scale tier → user custom profile → explicit override → resolve modelScale`

```javascript
function loadConfig(opencode) {
  const raw = opencode?.config?.heartbeat || {}
  
  // Detect scale (auto or explicit)
  const detectedOrExplicit = detectModelProfile(opencode)
  const scaleConfig = MODEL_SCALE_TIERS[detectedOrExplicit] || MODEL_SCALE_TIERS['small']
  // raw.profiles 的 key 必須是 scale tier 名稱 ('small'|'medium')，對應目前偵測到的 tier
  // 例如 detectedOrExplicit='medium' 時取 raw.profiles.medium
  const customProfile = raw.profiles?.[detectedOrExplicit] || {}
  
  // Merge: default ← scale tier ← custom profile ← explicit override
  const merged = deepMerge(DEFAULT_CONFIG, scaleConfig, customProfile, raw)
  delete merged.profiles
  // Store resolved scale for getPromptStyle
  merged.modelScale = detectedOrExplicit
  
  const { errors } = validateConfig(merged)
  if (errors.length > 0) {
    return { config: { ...DEFAULT_CONFIG, modelScale: 'small' }, errors }
  }
  return { config: merged, errors: [] }
}
```

> **注意：** `modelScale` 在 `loadConfig` 輸出時已被解析為具體的 `small|medium`（不再保留 `auto`）。後續 `getPromptStyle`、`checkAndInject` 等直接使用解析後的值。

**Task 1.4: Config validation — type + range**

Type check: 所有數值欄位必須是 `number` 且 >= 0
Range check: countdownSeconds >= 5, maxRecoveryAttempts >= 1, deathSpiralThreshold >= 1
logLevel: 必須是 `debug|warn|err` 之一

```javascript
function validateConfig(config) {
  const errors = []
  const numFields = ['countdownSeconds', 'maxRecoveryAttempts', /* ... 全部 11 個欄位 */]
  for (const field of numFields) {
    const val = config[field]
    if (val !== undefined && (typeof val !== 'number' || isNaN(val) || val < 0)) {
      errors.push(`${field}: must be positive number`)
    }
  }
  // Range checks
  if (config.countdownSeconds < 5) errors.push('countdownSeconds too low (<5)')
  // ... 其他 range checks
  if (!['debug', 'warn', 'err'].includes(config.logLevel)) errors.push('invalid logLevel')
  return { errors, config }
}
```

**Task 1.5: getPromptStyle — 根據 scale 選擇提示模板（2 種風格）**

> ⚠️ **規範：此處是 PROMPT_STYLES 的唯一 canonical 來源。**
> `2026-05-13-heartbeat-local-llm.md` 中的模板僅供設計參考，實作時以此處為準。
> 若需修改 prompt 模板，一律修改此檔案，並同步更新設計 doc（若想保留記錄）。

```javascript
// 兩種 Prompt 風格：ultra_short（小模型）/ short（中型模型）
// 移除 standard 風格 — 大型模型不需要此 plugin 輔助
const PROMPT_STYLES = {
  ultra_short: {
    continuation: '[續行] 還有 {n} 項。下一項：{task} 直接執行。完成用 todowrite。不要問。',
    toolErrorL1: '[續行] tool 失敗。重試 {task}。直接執行。',
    toolErrorL2: '[續行] tool 失敗 {n} 次。換方法做 {task}。直接執行。',
    toolErrorL3: '[續行] tool 一直失敗。用全新方法。不要用 {lastTool}。直接執行。',
    toolErrorL4: '[續行] tool 一直失敗。用 websearch 查解法。不要猜。',
    recoveryL0: '繼續',
    recoveryL1: '繼續任務',
    recoveryL2: '繼續: {task}',
    contextPressure: '[續行] context 壓力大。任務餘 {n}。{task} 直接完成，避免大型輸出。',
    stuck: '[續行] 卡住。換全新方法做 {task}。不要重複。直接執行。',
  },
  short: {
    continuation: '[續行] 還有 {n} 項需完成。下一項：{task}，完成後用 todowrite。',
    toolErrorL1: '[續行] tool 錯誤。重試「{task}」。注意指令。直接執行。',
    toolErrorL2: '[續行] tool 錯誤 {n} 次。請改用其他方式做「{task}」。不要重複。',
    toolErrorL3: '[續行] tool 持續錯誤。完全不一樣的方法：{suggestion}。',
    toolErrorL4: '[續行] tool 持續錯誤。先用 websearch 搜尋正確做法。',
    recoveryL0: '繼續任務',
    recoveryL1: '繼續執行',
    recoveryL2: '請繼續: {task}',
    contextPressure: '[續行] context 壓力大。任務剩 {n} 項。{task} 直接完成，避免長輸出。',
    stuck: '[續行] 卡住。換全新方法做「{task}」。不要重複相同步驟。',
  },
}

function getPromptStyle(config) {
  // config.modelScale 在 loadConfig 時已解析為 concrete scale
  const scale = config.modelScale || 'small'
  const tier = MODEL_SCALE_TIERS[scale] || MODEL_SCALE_TIERS['small']
  return PROMPT_STYLES[tier?.promptStyle || 'ultra_short'] || PROMPT_STYLES.ultra_short
}
```

## Module: utils.js

**Exports:**
- `sanitizeSessionID(raw)` → `{ string }`
- `estimateContextTokens(state, config)` → `{ number }`
- `estimateProcessTime(contextSize, speedTps)` → `{ number }`
- `makeLogger(logLevel)` → `{ log, warn, err }`
- `setSafeTimeout(fn, delay)` → `{ timerId }` (含 sleep guard)
- `clearAllTimers()`
- `isWakeAfterSleep(lastScheduledTime)` → `{ boolean }`
- `deepMerge(...objects)` → `{ merged }`
- `readTodos(client, opencode, sessionID, persistDir)` → `{ todos[] }` (NEW)
- `readTodosFromPersistence(sessionID, persistDir)` → `{ todos[] }` (NEW)

### 實作任務

**Task 1.6: sanitizeSessionID**

```javascript
function sanitizeSessionID(raw) {
  if (typeof raw !== 'string') return 'unknown'
  return raw.replace(/[^a-zA-Z0-9_\-]/g, '_')
}
```

**Task 1.7: estimateContextTokens (FIX — 獨立 exchangeCount)**

```javascript
// 與 toolCallHistory 獨立計數，修正雙重計算 bug
// ⚠️ _cachedContextSize 是唯獨 cache，在 state 被 createOrGetState 建立時設為 undefined
// context 會隨 toolCallHistory 成長而不斷變化，cache 需在每次 tool.completed 時失效：
//    handleToolCompleted(state, event) { state._cachedContextSize = undefined; ... }
function estimateContextTokens(state, config) {
  const base = 4000
  const toolTokens = (state.toolCallHistory?.length || 0) * 1000
  const exchangeTokens = (state.exchangeCount || 0) * 500
  const total = base + toolTokens + exchangeTokens
  const capped = Math.min(total, config.effectiveMaxContext || 32000)
  // 寫入 cache 供後續呼叫（同一 tick 內）
  state._cachedContextSize = capped
  return capped
}

function estimateProcessTime(contextSize, speedTps) {
  if (!speedTps || speedTps <= 0) return 0
  return (contextSize / speedTps) * 1000 * 1.5  // 乘以 1.5 的安全係數
}
```

**Task 1.8: 三級 logger (lazy init)**

⚠️ **重要設計決策：** logger 初始化必須延遲到 config 載入後。若在 module 層級立即初始化，此時 config 尚未載入，永遠使用 'warn' 級別。

```javascript
// Logger 工廠函數 — module 層級不初始化
// 各 module 在 onStart/config 載入後才呼叫 getLogger()
// 若在 module 層級直接 const {log,warn,err} = makeLogger() 會使 config 無效

let _currentLogger = null  // 模組層級持有，非 export

function makeLogger(level = 'warn') {
  const levels = { debug: 0, warn: 1, err: 2 }
  const current = levels[level] ?? 1
  return {
    log: (...args) => { if (current <= 0) console.log(...args) },
    warn: (...args) => { if (current <= 1) console.warn(...args) },
    err: (...args) => { if (current <= 2) console.error(...args) },
  }
}

// 統一日誌存取點：各 module 透過 getLogger().warn() 使用
// onStart 時以 config.logLevel 初始化
function initLogger(level) { _currentLogger = makeLogger(level) }
function getLogger() { return _currentLogger || makeLogger('warn') }
```

> **使用方式變更：** 各 module 不再在頂層 `const { log, warn, err } = makeLogger()`。改為在函數內使用 `getLogger().warn(...)`。或在 onStart 時呼叫 `initLogger(config.logLevel)` 後，透過 `getLogger()` 存取。此變更確保 logger 級別受 config 控制。

**Task 1.9: setSafeTimeout + macOS sleep guard + timer Set 管理**

```javascript
const activeTimers = new Set()

function setSafeTimeout(fn, delay) {
  const scheduledAt = Date.now()
  const id = setTimeout(() => {
    activeTimers.delete(id)
    if (isWakeAfterSleep(scheduledAt + delay)) {
      warn(`[TIMER] wake after sleep (${Date.now() - scheduledAt - delay}ms overdue)`)
      return  // skip callback, prevent mass injection on wake
    }
    try { fn() } catch (e) { err(`[TIMER] callback error: ${e.message}`) }
  }, delay)
  activeTimers.add(id)
  return id
}

function clearAllTimers() {
  for (const id of activeTimers) clearTimeout(id)
  activeTimers.clear()
}

function isWakeAfterSleep(lastScheduledTime) {
  return Date.now() - lastScheduledTime > 30000  // >30s gap = probable sleep/wake
}
```

**Task 1.10: deepMerge (簡單版，只處理 plain object)**

```javascript
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
```

**Task 1.10b: `readTodos` — Todo 讀取適配層 (NEW)**

```javascript
// 抽象化 todo 讀取，支援多種後端 + persistence fallback
// 設計參考：§假設 5

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
```

> **影響：** `checkAndInject`、`injectContinuation`、`buildInjectPrompt` 等需要 todos 的函數需改為 async，並接收 `readTodos` 的結果（詳見 Phase 4 更新）。

> **注意：** `persistDir` 的路徑 `.opencode/heartbeat-state/` 應為專案根目錄的相對路徑。在 Phase 4 的 index.js onStart 中，應先透過 `path.resolve(process.cwd(), '.opencode/heartbeat-state/')` 解析為絕對路徑再傳入各 module，避免 `process.cwd()` 不一致導致的路徑錯誤。

## Module: verify-api.js (獨立執行)

在開始 Phase 2 之前，執行此 script 確認 API 行為。參考設計參考 §假設 1 的完整程式碼。

**Task 1.11: API 驗證 script (雙模態)**

`verify-api.js` 同時支援兩種執行模式：

| 模式 | 執行方式 | 用途 |
|------|---------|------|
| **Standalone** | `node .opencode/plugins/smart-heartbeat-local/verify-api.js` | 快速驗證 API 行為，不需 OpenCode 環境 (mock API) |
| **Plugin** | 臨時加入 opencode.json: `"plugins": ["verify-api"]` | 在真實 OpenCode 環境中驗證 |

> ⚠️ **一定要先用 standalone 模式驗證。** Plugin 模式需修改 opencode.json，為一次性使用。驗證完後移除。

在 `verify-api.js` 中：
1. `client.session.prompt` — 注入兩次訊息 → 手動檢查 context 是否有兩條
2. `tool.started` / `tool.completed` / `tool.error` payload — 記錄 key 名稱
3. `opencode.showToast` — 確認 function 存在
4. `opencode.session.model` — 取得模型名稱
5. **Todo 讀取 API** — 嘗試 `client.session.getTodos()` 與 `opencode.session.todos`，記錄哪個可用

**Standalone 模式實作 (module.exports + 直接執行雙支援)：**

```javascript
// verify-api.js — 雙模態：require() 載入 + node 直接執行
// standalone 模式：內建 mock，不需 OpenCode 環境
// plugin 模式：export onStart，由 OpenCode 載入

// === Standalone 模式：內建 mock OpenCode API ===
const MOCK = {
  promptMode: null,
  events: {},
  showToast: false,
  modelName: 'gemma-4-4b',
  todoAPI: null,
}

async function runVerifyStandalone() {
  // 模擬 OpenCode 環境中的 API 行為
  // 1. Prompt 模式驗證 (依真實 API 文件)
  MOCK.promptMode = 'APPEND (預期，實際需手動確認)'
  
  // 2. Event payload 結構
  MOCK.events['tool.started'] = ['properties.sessionID', 'properties.name']
  MOCK.events['tool.completed'] = ['properties.sessionID', 'properties.name']
  MOCK.events['message.completed'] = ['info.role', 'info.sessionID']
  
  // 3. showToast
  MOCK.showToast = true
  
  // 4. Model name
  MOCK.modelName = process.env.OPENCODE_MODEL || 'gemma-4-4b'
  
  // 5. Todo API
  MOCK.todoAPI = '需待 OpenCode 文件確認 client.session.getTodos() 是否存在'
  
  console.log('[API-VERIFY] 驗證完成，請手動確認以下結果：')
  console.log(JSON.stringify(MOCK, null, 2))
  console.log('\n⚠️ 注意：promptMode 需在 OpenCode log 中手動確認 context 內容')
  return MOCK
}

// === Plugin 模式：由 OpenCode 載入 ===
module.exports = {
  onStart: async (opencode, client) => {
    const results = { promptMode: null, events: {}, showToast: false, modelName: null }
    // Plugin 模式使用真實 client/opencode API
    // (實作詳見設計參考 §假設 1)
    console.log('[API-VERIFY]', JSON.stringify(results, null, 2))
  },
}

// Standalone 直接執行
if (require.main === module) {
  runVerifyStandalone()
}
```

> **第 5 項的詳細驗證程式碼與應變方案，請參考 `2026-05-13-heartbeat-local-llm.md` §假設 5。**

**注意：** 若所有 todo 讀取 API 都不可用，Phase 4 的 `checkAndInject` 需全部依賴 persistence fallback，且 state persistence 的 debounce 必須從 5s 降到 1s（在 Task 2.2 調整 `persistState` 的 debounce 參數）。

## Module: mock.js (測試基礎設施)

所有 Phase 測試共用的 mock 基礎設施。

**Task 1.12: Mock infrastructure**

```javascript
// test/mock.js — 輸出物件介面
module.exports = {
  // mockOpencode: 模仿 opencode 全域物件
  // 屬性: showToast, session.model
  // 方法: showToast(msg, type) → void
  //       session.model → 'gemma-4-4b' (可設定)
  mockOpencode: {
    showToast: (msg, type) => { /* no-op */ },
    session: { model: 'gemma-4-4b' },
  },

  // mockClient: 模仿 client API
  // 屬性: handlerCount, handlers{}
  // 方法: on(event, handler) → handlerCount++
  //       session.prompt({message, sessionID}) → Promise
  mockClient: {
    _handlers: {},
    handlerCount: 0,
    on(event, handler) {
      this._handlers[event] = handler
      this.handlerCount++
    },
    session: {
      async prompt({ message, sessionID }) { /* no-op */ },
    },
  },

  // mockEvent: 產生活動 payload
  // mockEvent('tool.started', { name: 'edit', sessionID: 'ses-1' })
  mockEvent(type, overrides = {}) {
    const base = { sessionID: 'test-ses' }
    if (type === 'tool.started') return { ...base, name: 'edit', ...overrides }
    if (type === 'tool.completed') return { ...base, ...overrides }
    if (type === 'tool.error') return { ...base, name: 'bash', ...overrides }
    return { ...base, ...overrides }
  },

  // fakeTimers: 完整自製 timer queue，不依賴真實 setTimeout
  // 同時 mock Date.now() 使 isWakeAfterSleep 等時間判斷正確
  // use: fakeTimers.install() → advanceTime(ms) → fakeTimers.restore()
  fakeTimers: {
    _originalSetTimeout: null,
    _originalDateNow: null,
    _queue: [],         // [{id, fireAt, fn}]
    _nextId: 1,
    _currentTime: 0,
    _installed: false,

    install() {
      if (this._installed) return
      this._installed = true
      this._originalSetTimeout = global.setTimeout
      this._originalDateNow = global.Date.now
      this._queue = []
      this._nextId = 1
      this._currentTime = Date.now()  // capture real time as base

      // 1. 自製 timer queue — 不呼叫真實 setTimeout
      global.setTimeout = (fn, delay, ...args) => {
        const id = this._nextId++
        const fireAt = this._currentTime + (delay || 0)
        this._queue.push({ id, fireAt, fn: () => fn(...args) })
        return id
      }

      // 2. 固定 Date.now — advanceTime() 控制時間流
      global.Date.now = () => this._currentTime
    },

    advanceTime(ms) {
      if (!this._installed) return
      this._currentTime += ms

      // 找出所有到期 timer，依 fireAt 排序執行
      const ready = this._queue
        .filter(t => t.fireAt <= this._currentTime)
        .sort((a, b) => a.fireAt - b.fireAt)

      // 先從 queue 移除，再執行（防止 callback 中註冊新 timer 影響排序）
      this._queue = this._queue.filter(t => t.fireAt > this._currentTime)

      for (const t of ready) {
        try { t.fn() } catch (e) { console.error('[FAKE_TIMER] callback error:', e) }
      }
    },

    restore() {
      if (!this._installed) return
      this._installed = false
      global.setTimeout = this._originalSetTimeout
      global.Date.now = this._originalDateNow
      this._queue = []
    },
  },
}
```

## Phase 1 單元測試

### task/phase1-config.test.js — 10 cases

| 測試目標 | 案例 | 測試重點 |
|---------|------|---------|
| `validateConfig()` | 4 | 合法 config / 無效 type / 缺失欄位 / 邊界值 (countdown<5) |
| `detectModelProfile()` | 2 | model name 存在時正確分級 / 無資訊 fallback 到 small |
| `detectModelScale()` | 2 | 參數數值解析 (4b→small, 14b→medium) / 無參數數值走 family default (gemma→small) |
| `parseParamCountFromModelName()` | 1 | 正則解析: `6.7b`→small / `14b-v0.1`→medium / 無匹配→null (與 `detectModelScale` 分開測) |
| `getPromptStyle()` | 1 | 依 modelScale 回傳對應 style，無效值 fallback 到 ultra_short |

```javascript
// Example: parseParamCountFromModelName — 正則解析參數數值
assert.strictEqual(parseParamCountFromModelName('gemma-4-4b'), 'small')   // 4B < 10
assert.strictEqual(parseParamCountFromModelName('qwen3.5-14b-MTP'), 'medium')  // 14B >= 10
assert.strictEqual(parseParamCountFromModelName('llama-3-70b'), 'medium')  // 70B >= 10
assert.strictEqual(parseParamCountFromModelName('mixtral-8x7b'), null)     // MoE 跳過 (避免誤判)
assert.strictEqual(parseParamCountFromModelName('no-param-here'), null)

// Example: detectModelScale — 完整偵測邏輯 (只有 small/medium)
assert.strictEqual(detectModelScale('gemma-4-4b'), 'small')   // param parsing: 4B
assert.strictEqual(detectModelScale('phi-4-7b'), 'small')    // 7B < 10
assert.strictEqual(detectModelScale('llama-3-8b'), 'small')  // 8B < 10
assert.strictEqual(detectModelScale('qwen3.5-14b'), 'medium') // 14B >= 10
assert.strictEqual(detectModelScale('llama-3-70b'), 'medium') // 70B >= 10
assert.strictEqual(detectModelScale('mixtral-8x7b'), 'medium') // MoE 跳過 regex → family default
assert.strictEqual(detectModelScale('unknown-model'), null)    // unparseable
assert.strictEqual(detectModelScale(null), null)

// Example: detectModelProfile — 完整入口 (只支援 small/medium)
assert.strictEqual(detectModelProfile({ session: { model: 'gemma-4-4b' } }), 'small')
assert.strictEqual(detectModelProfile({}), 'small')  // fallback
assert.strictEqual(detectModelProfile({
  session: { model: 'unknown-v0.1' },
  config: { heartbeat: { modelScale: 'medium' } }
}), 'medium')  // explicit override

assert.strictEqual(detectModelProfile({ session: { model: 'unknown-v0.1' } }), 'small')  // unknown fallback
```
> **注意：** 此 plugin 僅支援 small/medium 兩級。任何 >=10B 的模型（包括 70B）都歸入 medium。若模型實際能力超出預期，使用者仍可在 `opencode.json` 手動調整各項參數。

### task/phase1-utils.test.js — 11 cases

| 測試目標 | 案例 | 測試重點 |
|---------|------|---------|
| `sanitizeSessionID()` | 3 | 正常 alphanumeric / 特殊字元 → `_` / 非字串 → `unknown` |
| `estimateContextTokens(FIX)`| 5 | 正常路徑 / exchangeCount 獨立加成 / 空 history / cap threshold / 超大值 |
| `estimateProcessTime()` | 2 | 正常 context+speed / speed=0 回傳 0 |
| `isWakeAfterSleep()` | 1 | >30s 回傳 true / <=30s 回傳 false |

> `readTodos` 與 `readTodosFromPersistence` 的測試涵蓋在 Phase 4 整合測試與 Phase 5 系統測試中（因為它們依賴 OpenCode API mock，不適合純 unit test）。

```javascript
// Key test: exchangeCount is independent from toolCallHistory (FIX)
const state1 = { toolCallHistory: [{name:'edit',time:1,status:'ok'}], exchangeCount: 5 }
const state2 = { ...state1, exchangeCount: 0 }
assert.notStrictEqual(
  estimateContextTokens(state1, {effectiveMaxContext: 32000}),
  estimateContextTokens(state2, {effectiveMaxContext: 32000}),
  'exchangeCount must independently affect estimation'
)
// isWakeAfterSleep
assert.strictEqual(isWakeAfterSleep(Date.now() - 1000), false)  // normal
assert.strictEqual(isWakeAfterSleep(Date.now() - 35000), true)  // sleep
```

## Checkpoint Gate #1

通過條件：
1. `node -c .opencode/plugins/smart-heartbeat-local/config.js` → 無錯誤
2. `node -c .opencode/plugins/smart-heartbeat-local/utils.js` → 無錯誤
3. `verify-api.js` 已執行至少一遍，**且結果已寫入文件**（例如 `verify-results.json` 或附註在 `2026-05-13-heartbeat-local-llm.md` 中）
4. 下列 5 個 API 行為的驗證結果已有明確記錄：
   - `client.session.prompt` 模式：APPEND / REPLACE / INJECT
   - `tool.started` payload key 結構
   - `tool.completed` payload key 結構
   - `opencode.showToast` 是否存在
   - todo 讀取 API：`client.session.getTodos()` / `opencode.session.todos` 哪個可用

**未通過前不要開始 Phase 2。** 尤其是 verify-api 的結果（特別是 `client.session.prompt` 模式）可能影響整個 injector 設計。若為 REPLACE 模式，Phase 1 的 injector 架構需重新設計。
