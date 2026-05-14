# Smart Heartbeat — Local LLM 專用版

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立專為 local LLM（Gemma 4 4B、Qwen3.5、LocoOperator 等）設計的 Smart Heartbeat plugin，解決 local model 速度慢、tool calling 弱、容易卡住、context 壓力大、以及**復原後模型容易再次忘記**等問題

**Architecture:** 以 global heartbeat 為基礎，針對 local LLM 特性重新設計：更慢的節奏、更強力的續行提示、tool 錯誤復原、context 壓力監控、進度持久化、以及**具備反饋迴圈的復原狀態機**

**Tech Stack:** JavaScript, OpenCode Plugin API

---

## 目錄

1. [Local LLM 特性](#local-llm-特性--需要調整的面向)
2. [設計目標](#設計目標)
3. [檔案結構](#檔案結構)
4. [與 Global Version 的差異](#與-global-version-的差異對照) — Session State、時序參數、Context 估算、提示風格、持久化、Context 監控
5. [關鍵功能 6-9](#關鍵功能-6-prompt-processing-感知-gemma-4-4b-專用) — Processing Guard / In-Flight Tool / Recovery 狀態機 / Tool 錯誤分級
6. [Injector Routing Matrix](#9g-injector-routing-matrix--從-prompttype-到具體模板)
7. [架構圖](#架構圖更新版含-recovery-state-machine)
8. [關鍵假設與風險](#關鍵假設與風險) — API 驗證、Compaction Event、Context Size
9. [設定檔結構](#設定檔結構-opencodejson) — 22 參數、2 級 Model Scale、Auto-Detect
10. [安全與強化](#安全與強化) — Sanitize / LRU / Lifecycle / Config Validation / 衝突 / Sleep Guard
11. [事件交錯規則](#事件交錯規則-event-interleaving) — 5 條規則 + 使用者介入 + 營運觀測
12. [測試策略](#測試策略) — 104 測試案例、Mock Infra
13. [實作階段](#實作階段) — Phase 1-2 任務與行數估計
14. [續行提示模板](#續行提示模板gemma-4-4b-專用)
15. [實作檢查清單](#實作完成-check-list)

---

## Local LLM 特性 — 需要調整的面向

| 特性           | Cloud Model (big-pickle)   | Local Model (Gemma 4 4B / Qwen3.5) | 影響                             |
| -------------- | -------------------------- | ---------------------------------- | -------------------------------- |
| 速度           | ~100+ tok/s                | ~25-40 tok/s                       | 需要更長 timeout                 |
| Tool calling   | 可靠                       | 易出錯、亂選 tool                  | 需要 tool error 復原             |
| Context 可用度 | 高（大 context）           | 低（32K-131K 但實際更小）          | 需要 context 監控                |
| 指令跟隨       | 強                         | 弱                                 | 需要更簡單直接的提示             |
| 卡住傾向       | 低                         | 高（容易 loop）                    | 需要更靈敏的卡住偵測             |
| 續行提示       | 能處理複雜指令             | 需要"強迫語氣"                     | 提示要更簡潔有力                 |
| **復原穩定性** | **高（恢復後能持續運作）** | **低（恢復後很快又忘記）**         | **需要反饋迴圈驗證復原是否成功** |

---

## 設計目標

1. **慢節奏** — countdown 30s+，minInterval 60s+，給 local model 足夠時間
2. **tool 錯誤容錯** — 自動重試、提供替代方案、不要輕易放棄
3. **進度持久化** — 當 local model 失去 context，從檔案恢復任務狀態
4. **擬人化續行提示** — 模仿使用者催促的口吻，直接用「繼續」、「不要停」等指令
5. **Context 壓力監控** — 估算 tool output 大小，在 context 滿之前預警
6. **卡住模式分析** — 不只檢查 todo，也分析 tool 呼叫模式（重複、錯誤、閒置）
7. **Prompt Processing 感知** — 根據 context 大小動態調整 timeout，避免在模型尚未回應時重複注入
8. **In-Flight Tool 追蹤** — 監控 `task` 等長時間 tool，模型等待期間不觸發續行
9. **復原反饋迴圈** — inject 後驗證模型是否真的繼續執行，失敗時逐級升級提示，偵測死亡螺旋
10. **可測試性** — 純函數與 side-effect 分離，支援 mock 測試，104 個測試案例（21 Phase 1 + 24 Phase 2 + 40 Phase 3 + 10 Phase 4 + 9 Phase 5），P0/P1/P2 三級

---

## 檔案結構

Phase 1 採用多檔案拆分（詳細說明見 §建議 4：檔案拆分策略）：

```
.opencode/
├── plugins/
│   ├── smart-heartbeat-local/
│   │   ├── index.js          # Plugin entry + event router + lifecycle (~100 行)
│   │   ├── config.js         # Config schema + validation + model scale (~120 行)
│   │   ├── state.js          # State management + persistence + LRU (~130 行)
│   │   ├── monitor.js        # Tool monitoring + context pressure + stuck (~110 行)
│   │   ├── recovery.js       # Recovery state machine + death spiral + timers (~140 行)
│   │   ├── injector.js       # Prompt building + routing matrix + styles (~120 行)
│   │   └── utils.js          # sanitizeSessionID, estimateContextTokens, log (~80 行)
│   └── verify-api.js         # API 驗證 plugin (NEW, 獨立執行, ~50 行)
├── opencode.json              # 專案設定（註冊 plugin）
└── heartbeat-state/           # 進度持久化目錄（自動建立）
    └── {sessionID}.json       # 每 session 的任務狀態快照
```

> **為何拆分：** 單一檔案估計 ~845 行已超過合理維護上限。各 module 有自然邊界（event / state / decision / output），拆分不增加複雜度。測試也可對應 module 拆分。
>
> ⚠️ **規範對照表：** 本設計文件為設計參考與原理說明。實際實作時，若與 Phase sub-plan 不一致，**以 sub-plan 為準**：
> - `PROMPT_STYLES` 模板 → **canonical 來源為 `01-foundation.md` Task 1.5**，此處僅供參考
> - 使用者介入處理（`handleUserMessage` / `handleUserCommand`）→ **canonical 來源為 `04-ux-integration.md` Task 4.3**
> - `contextWarnings` 重置策略 → **採用 `04-ux-integration.md` 的「不重置」策略**
> - `detectTruncation` 實作 → **`02-state-monitoring.md` Task 2.9**
> - 測試數量 → **統一為 104（21+24+40+10+9）**

---

## 與 Global Version 的差異對照

### 1. Session State 擴充

```javascript
state = {
  // ===== 既有欄位 =====
  currentAgent: null,
  consecutiveFailures: 0,
  stuckCount: 0,
  inProgress: false,
  enabled: false,

  // ===== Tool 監管 =====
  toolCallHistory: [],          // [{name, time, status}], max 20
  toolErrorCount: 0,            // 連續 tool 錯誤次數
  lastToolName: null,           // 最近 tool 名稱
  lastToolTime: null,           // 最近 tool 時間戳
  repeatedToolCount: 0,         // 同一 tool 連續次數
  inFlightTool: null,           // { name, startTime, timeout } ─ 正在執行的 tool
  waitingForTool: false,        // true = 模型在等 tool 回傳（如 task）

  // ===== Prompt Processing 感知 =====
  lastInjectionTime: 0,         // 上次續行注入時間
  estimatedProcessTime: 0,      // 預估 prompt processing 時間 (ms)
  processingGuard: false,       // processing 期間跳過所有續行檢查

  // ===== Context 監控 =====
  contextWarnings: 0,           // context 壓力等級 (0-3)
  largeOutputCount: 0,          // 大型 tool output 次數

  // ===== 復原狀態機 (NEW) =====
  recoveryState: 'idle',        // idle | injected | verified | failed | stopped
  recoveryLevel: 0,             // 漸進提示層級 (0-3)，每次失敗遞增
  recoveryAttempts: 0,          // 本次 session 總復原嘗試次數
  lastRecoveryTime: 0,          // 上次復原時間戳
  recoveryVerificationStage1: null,  // 第一階段驗證 timer
  recoveryVerificationStage2: null,  // 第二階段驗證 timer
  recoveryQuality: 'unknown',   // unknown | good | confused | failed
  truncationEvents: [],         // [{time, success}] ring buffer, max 10
  deathSpiral: false,           // true = 偵測到死亡螺旋，停止復原
  lastToolBeforeTruncation: null, // 截斷前最後執行的 tool，用於品質對比

  // ===== 對話交換計數 (FIX) =====
  exchangeCount: 0,             // user/assistant 對話回合數，用於 context 估算修正

  // ===== 既有復原欄位 =====
  recoveryCount: 0,             // persistence 中記錄的復原次數
  lastProgressFile: null,       // 進度檔案路徑

  // ===== 安全與資源管理 (NEW) =====
  sessionIDSafe: '',            // 經 sanitize 的 sessionID，用於檔案路徑
  lastActivity: 0,              // 上次活動時間，用於 LRU eviction
}
```

### 2. 時間參數（更慢、更寬容、動態）

| 參數                        | Global | Local  | 說明                                                         |
| --------------------------- | ------ | ------ | ------------------------------------------------------------ |
| countdownSeconds            | 10     | 30     | 基礎倒數（最終 timeout = max(countdown, estimatedProcessTime*1.5)） |
| minIntervalMs               | 30000  | 90000  | 兩次續行最小間隔                                             |
| maxStuckCycles              | 3      | 8      | Todo 沒變化多少次才判定卡住                                  |
| maxToolErrors               | —      | 8      | 連續 tool 錯誤次數上限                                       |
| maxRepeatedTool             | —      | 10     | 同一 tool 連續呼叫上限                                       |
| maxIdleSeconds              | —      | 120    | 無任何 tool 活動的 idle 上限                                 |
| promptSpeedTps              | —      | 50     | Prompt processing 速度 (tok/s)，用於 adaptive timeout        |
| maxRecoveryAttempts         | —      | 3      | 復原嘗試次數上限（含漸進升級）                               |
| recoveryVerificationMaxMs   | —      | 60000  | 復原驗證 timer 最大等待時間 (ms)                             |
| deathSpiralWindowMs         | —      | 300000 | 死亡螺旋偵測時間窗口 (5分鐘)                                 |
| deathSpiralThreshold        | —      | 3      | 窗口內觸發復原次數上限                                       |
| toolTimeout.task            | —      | 300    | task tool timeout (s)，config.toolTimeout.task               |
| toolTimeout.bash            | —      | 120    | bash tool timeout (s)                                        |
| toolTimeout.edit            | —      | 60     | edit/write tool timeout (s)                                  |
| toolTimeout.read            | —      | 30     | read/glob/grep tool timeout (s)                              |
| toolTimeout.default         | —      | 60     | 通用 tool timeout (s)                                        |
| logLevel                    | —      | "warn" | 日誌級別: debug \| warn \| err                               |
| effectiveMaxContext         | —      | 32000  | 有效 context 上限 (tokens)，用於推估公式                     |
| persistence.maxFiles        | —      | 100    | 最大 persistence 檔案數                                      |
| persistence.cleanupAgeHours | —      | 24     | 檔案保留時數                                                 |
| persistence.debounceMs      | —      | 5000   | persistence 寫入 debounce (ms)                               |

**Adaptive Timeout 公式：**

```
effectiveTimeout = max(
    config.countdownSeconds * 1000,
    estimatedContextTokens / config.promptSpeedTps * 1000 * 1.5
)
```

### 2b. estimatedContextTokens 演算法

Plugin 無法直接取得 context size，需透過事件推估：

```javascript
function estimateContextTokens(state, config) {
  if (state._cachedContextSize !== undefined) return state._cachedContextSize

  // Base: system prompt + AGENTS.md ~4000 tokens
  const base = 4000
  
  // Tool call history: 每次 tool call ~1000 tokens (input + output)
  const toolTokens = (state.toolCallHistory?.length || 0) * 1000
  
  // 使用者對話: 每個 exchange ~500 tokens
  // exchangeCount 在 message.completed (user role) 時遞增
  // 與 toolCallHistory 獨立計數，修正雙重計算 bug
  const exchangeTokens = (state.exchangeCount || 0) * 500
  
  const total = base + toolTokens + exchangeTokens
  
  // Cap at effective max context (需要 config 參數來取得上限)
  return Math.min(total, config?.effectiveMaxContext || 32000)
}
```

**注意：** 此為粗略估算，僅用於 adaptive timeout 和 verification timer delay 的參考。
精確值需 OpenCode API 提供 tokenizer 或 contextSize 查詢。若無法估算，使用 `effectiveMaxContext` 作為保守值。

**修正記錄：** 原版 `exchangeTokens` 誤用 `toolCallHistory.length`（兩個變數成比例），無法反映真實對話結構。現已獨立為 `exchangeCount`，在 `message.completed(info.role=user)` 時 +1。

### 3. 續行提示風格（更強勢、更簡短）

Global 版：

```
還有 N 個任務未完成：
1. 任務 A
繼續執行「任務 A」，完成後用 todowrite 設為 completed。
```

Local 版：

```
[系統續行] 還有 N 個任務待完成。

下一項：任務 A

重要：直接執行，不要問問題，不要停下來。完成後再用 todowrite。
```

### 4. 進度持久化

Global 版：無記憶 → context 壓縮後 agent 忘記任務。

Local 版：每次 todo 變化時寫入 `.opencode/heartbeat-state/{sessionID}.json`，當 local model 失去 context 或續行時先讀取此檔案：

```json
{
  "sessionID": "ses_xxx",
  "version": 1,
  "updated": "2026-05-13T22:00:00+08:00",
  "incomplete": [
    { "content": "任務 A", "status": "in_progress" },
    { "content": "任務 B", "status": "pending" }
  ],
  "currentTask": "任務 A",
  "toolErrorCount": 2,
  "lastToolName": "edit",
  "toolCallCount": 15,
  "repeatedToolCount": 0,
  "notes": "edit 遇到 syntax error，需要重試",
  "recoveryAttempts": 0,
  "recoveryLevel": 0
}
```

### 5. Context 壓力監控

Gemma-4 4B 的 context windows 號稱 131K，但超過 ~32K 後嚴重降速。

在 `tool.completed` 時估算 tool output 大小，累計警告：

- tool output > 2000 tokens → 記錄大 output 次數
- 大 output 累計 >= 3 次 → contextWarnings++
- contextWarnings >= 3 → 在續行提示加入 context 壓力警告
- **contextWarnings >= 3 → pre-recovery context check 阻止復原注入**

---

## 關鍵功能 6: Prompt Processing 感知 (Gemma-4 4B 專用)

### 問題

Gemma-4 4B on M4 Pro：

- Prompt processing（吃 context）：~50-100 tok/s
- Generation：~30-40 tok/s

當 context 累積到 20K tokens，每次續行注入後模型需要 **200-400 秒** 消化 context，才會開始生成第一個 token。

若 timeout 是固定 30s，heartbeat 會在模型還在吃 context 時判定 idle → 再注入第二發 → 疊加更多 context → 更慢 → 惡性循環。

### 解決方案：Adaptive Timeout

```
estimatedProcessTime = currentContextSize / promptSpeed * 1500ms
e.g., 20000 / 50 * 1500 = 600000ms = 600s

effectiveTimeout = max(countdownSeconds * 1000, estimatedProcessTime)
```

### Processing Guard

注入續行後立即啟動 guard：

```javascript
// 注入續行後
state.lastInjectionTime = Date.now();
state.processingGuard = true;

// processingGuard 生效期間，跳過所有續行檢查
// 監控 tool.started 事件作為「模型醒了」的信號
// tool.started 發生時 → processingGuard = false
```

### Tool.started 做為「模型醒來」的信號

當模型完成 prompt processing 並開始生成時，第一個動作通常是 tool call（或文字回應）。這是解除 processing guard 的關鍵信號。

---

## 關鍵功能 7: In-Flight Tool 追蹤

### 問題

當 primary agent 呼叫 `task` 工具 dispatch subagent 時：

1. 模型送出 `task` tool call
2. OpenCode 啟動 subagent session 執行任務
3. **模型進入等待狀態，無法回應任何事件**
4. 這時 heartbeat 看到 assistant 訊息閒置 → 判定 idle → 錯誤注入續行
5. 但模型根本無法處理（它在等 subagent 回傳）

### 解決方案

```javascript
// tool.started name=task
state.inFlightTool = { name: "task", startTime: Date.now(), timeout: 300000 };
state.waitingForTool = true;

// 續行檢查時
if (state.waitingForTool) {
    // 模型在等 tool 回傳，跳過續行
    // 但檢查 tool timeout：如果 task 太久沒完成
    if (Date.now() - state.inFlightTool.startTime > state.inFlightTool.timeout) {
        // tool 可能卡住，注入特殊續行
    }
    return;
}

// tool.completed name=task
state.inFlightTool = null;
state.waitingForTool = false;
```

### Tool Timeout 對照表

| Tool           | Default Timeout | 意義                 |
| -------------- | --------------- | -------------------- |
| task           | 300s (5min)     | Subagent 任務執行    |
| bash           | 120s (2min)     | 指令執行可能 hang    |
| write/edit     | 60s             | 檔案操作正常不該超過 |
| read/glob/grep | 30s             | 讀取操作很快         |
| default        | 60s             | 通用保護             |

### Tool 順序圖（含復原狀態機）

```
續行注入 → prompt processing (guard ON)
  └── tool.started → guard OFF, inFlightTool={name,startTime}
        ├── 一般 tool → 計數、重複偵測、完成後記錄
        │     └── recovery 驗證中 → clear verification timer → success
        ├── task tool → waitingForTool=true → 跳過續行
        │     └── tool.completed (task) → waitingForTool=false → 恢復續行
        └── recovery 注入中 → 清除復原驗證 timer → 標記復原成功
```

---

## 關鍵功能 8: Recovery 反饋迴圈狀態機 (核心新功能)

### 問題：現有規劃的盲區

當前 recovery 是**線性流程**：

```
truncation → detect → inject → done
```

但 Gemma-4 4B 的短 context (~32K effective) 導致：

1. Recovery prompt 本身消耗 context budget (+0.5K~2K token)
2. 模型恢復後很快又觸發 truncation
3. **復原後不檢查是否真的成功**
4. 失敗時用**相同 prompt 重試**，不考慮逐步升級
5. 無死亡螺旋偵測 → 可能 loop 到 recovery limit 才停

**真實場景的死亡螺旋：**

| 循環 | Context 狀態                          | Recovery 存活時間 |
| ---- | ------------------------------------- | ----------------- |
| T1   | 28K→15K (truncation) → inject → 15.5K | ~3-4 tool calls   |
| T2   | 26K→15K (truncation) → inject → 15.5K | ~2-3 tool calls   |
| T3   | 24K→15K (truncation) → inject → 15.5K | ~1-2 tool calls   |

每次 recovery 加速下一次 truncation。若無死亡螺旋偵測，使用者浪費 60-90s。

### 解決方案：反饋迴圈狀態機

```
                      ┌──────────────────────────────┐
                      │         IDLE                  │
                      │  (正常監控中)                  │
                      └──────┬───────────────────────┘
                             │ truncation detected
                             ▼
                      ┌──────────────────────────────┐
                      │  PRE-RECOVERY CHECK           │
                      │  ├ context pressure OK?       │
                      │  ├ death spiral?              │
                      │  └ recovery attempts < max?   │
                      └──────┬───────────────────────┘
                             │ pass
                             ▼
                      ┌──────────────────────────────┐
                      │  INJECT RECOVERY              │
                      │  ├ select prompt level (0-3)  │
                      │  ├ save persistence           │
                      │  └ start verification timer   │
                      └──────┬───────────────────────┘
                             │
                    ┌────────┴────────┐
                    │                 │
                    ▼                 ▼
          ┌──────────────┐   ┌──────────────┐
          │ tool.started  │   │ timer expire │
          │ (verified OK) │   │ (no response)│
          └──────┬───────┘   └──────┬───────┘
                 │                  │
                 ▼                  ▼
          ┌──────────────┐   ┌──────────────┐
          │  VERIFIED     │   │  FAILED      │
          │  (monitor     │   │  (increment   │
          │   quality)    │   │   counter)    │
          └──────┬───────┘   └──────┬───────┘
                 │                  │
                 │           ┌──────┴──────┐
                 │           │             │
                 │           ▼             ▼
                 │   ┌────────────┐  ┌──────────┐
                 │   │ attempts<  │  │attempts>=│
                 │   │ max?       │  │ max?     │
                 │   │ → escalate │  │ → STOP   │
                 │   │ → INJECT   │  │   (notify)│
                 │   └────────────┘  └──────────┘
                 │
                 ▼
          ┌──────────────────────────────┐
          │  QUALITY CHECK               │
          │  ├ tool repetition?          │
          │  ├ error rate spike?         │
          │  └ mark quality: good|confuse│
          └──────┬───────────────────────┘
                 │
                 ▼
          ┌──────────────────────────────┐
          │  DEATH SPIRAL CHECK          │
          │  ├ 3+ truncations in 5min?   │
          │  ├ 2+ consecutive failures?  │
          │  └ if yes: mark deathSpiral  │
          └──────┬───────────────────────┘
                 │
                 ▼
              IDLE (或 STOPPED)
復原已停止狀態：
```

### State Machine States

```
idle → injected → verified → idle (正常循環)
idle → injected → failed → injected (升級重試，最多 3 次)
idle → injected → failed → stopped (超過次數上限)
idle → [pre-check fails] → idle (跳過本次復原)
idle → [deathSpiral=true] → stopped (死亡螺旋，永久停止)
```

### 實現細節

#### 8a. 漸進提示升級 (Progressive Prompt Escalation)

```javascript
const PROMPT_LEVELS = [
  // Level 0: 最低 context 成本，用於第一次嘗試
  (todos, state) => '繼續',
  
  // Level 1: 稍微明確
  (todos, state) => '繼續任務',
  
  // Level 2: 指定具體任務名稱
  (todos, state) => {
    const task = todos.find(t => t.status === 'in_progress') || todos[0]
    return `繼續: ${task?.content || '任務'}`
  },
  
  // Level 3: 完整 todo 重新注入（最後手段）
  (todos, state) => buildFullRecoveryPrompt(todos, state)
]

// Level 0-2 的 context 成本極低（< 10 tokens），不加速死亡螺旋
// Level 3 使用較多 context，但此時已是最後一次嘗試
// 每次失敗遞增 level，成功後重置為 0
```

**Level 選擇邏輯：**

- 首次復原：level 0（最小成本）
- 首次失敗 → level 1
- 第二次失敗 → level 2
- 第三次失敗 → level 3（最後手段）
- 超過 3 次 → STOPPED

#### 8b. 雙階段復原驗證 Timer (Two-Stage Verification)

直接給 timeout 有兩個難題：

- 設太短 → Gemma-4 還在 processing 就被判定失敗（false positive）
- 設太長 → 使用者等待過久

**雙階段解決方案：**

```javascript
function startRecoveryVerification(sessionID, config) {
  const state = states.get(sessionID)
  if (!state) return

  // 清除舊 timer
  clearRecoveryVerification(state)

  // Stage 1: 等 estimatedProcessTime * 0.7，至少 15s
  const stage1Delay = Math.max(15000, state.estimatedProcessTime * 0.7)
  
  // Stage 2: stage1 的兩倍，最多 config.recoveryVerificationMaxMs
  const maxVerificationMs = config?.recoveryVerificationMaxMs || 60000
  const stage2Delay = Math.min(stage1Delay * 2, maxVerificationMs)

  state.recoveryVerificationStage1 = setTimeout(() => {
    // Stage 1 到期 → 模型可能還在 processing
    // 不判定失敗，但記錄 slow processing
    log(`[WARN] [${sessionID}] recovery processing slow (>${stage1Delay}ms)`)
    
    // 啟動 stage 2
    state.recoveryVerificationStage2 = setTimeout(() => {
      // Stage 2 到期 → 真的沒反應
      handleRecoveryFailure(sessionID)
    }, stage2Delay - stage1Delay)
    
  }, stage1Delay)
  
  // 記錄 timer 資訊供除錯
  state._recoveryTimerInfo = { stage1Delay, stage2Delay }
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

**驗證成功信號：** `tool.started` 事件觸發時，清除驗證 timer，標記 recovery success。

```javascript
function handleToolStarted(sessionID, toolEvent) {
  const state = states.get(sessionID)
  if (!state) return
  
  // === Recovery verification ===
  if (state.recoveryState === 'injected') {
    clearRecoveryVerification(state)
    handleRecoverySuccess(sessionID, toolEvent)
  }
  
  // === Processing guard release ===
  if (state.processingGuard) {
    state.processingGuard = false
  }
  
  // === In-flight tool tracking ===
  // ... (既有的 in-flight tool 邏輯)
}

function handleRecoverySuccess(sessionID, toolEvent) {
  const state = states.get(sessionID)
  if (!state) return
  
  state.recoveryState = 'verified'
  state.recoveryQuality = 'unknown' // 等待 quality check
  state.recoveryLevel = 0 // 重置漸進層級
  
  // 更新 truncationEvents
  const lastEvent = state.truncationEvents[state.truncationEvents.length - 1]
  if (lastEvent) lastEvent.success = true
  
  log(`[OK] [${sessionID}] recovery verified (attempt ${state.recoveryAttempts})`)
}
```

#### 8c. 復原失敗處理

```javascript
function handleRecoveryFailure(sessionID) {
  const state = states.get(sessionID)
  if (!state) return
  
  state.recoveryState = 'failed'
  
  // 更新 truncationEvents
  const lastEvent = state.truncationEvents[state.truncationEvents.length - 1]
  if (lastEvent) lastEvent.success = false
  
  log(`[WARN] [${sessionID}] recovery failed (attempt ${state.recoveryAttempts})`)
  
  // 檢查死亡螺旋
  if (detectDeathSpiral(state)) {
    state.deathSpiral = true
    state.recoveryState = 'stopped'
    log(`[WARN] [${sessionID}] death spiral confirmed, recovery stopped`)
    // 通知使用者（透過 log / 未來的 toast）
    return
  }
  
  // 是否重試？
  if (state.recoveryAttempts < config.maxRecoveryAttempts) {
    // 升級提示層級 + 重試
    state.recoveryLevel = Math.min(state.recoveryLevel + 1, 3)
    executeRecovery(sessionID)
  } else {
    // 超過次數上限
    state.recoveryState = 'stopped'
    log(`[WARN] [${sessionID}] max recovery attempts (${config.maxRecoveryAttempts}) reached`)
  }
}
```

#### 8d. 死亡螺旋偵測

```javascript
function detectDeathSpiral(state, now = Date.now()) {
  const windowStart = now - config.deathSpiralWindowMs
  
  // 方法 1: 短時間內多次 truncation
  const recentEvents = state.truncationEvents.filter(e => e.time >= windowStart)
  if (recentEvents.length >= config.deathSpiralThreshold) {
    return true
  }
  
  // 方法 2: 連續失敗（recovery 注入後模型完全沒反應）
  const recentFailures = recentEvents.filter(e => e.success === false)
  if (recentFailures.length >= 2) {
    return true
  }
  
  // 方法 3: context 壓力過高
  if (state.contextWarnings >= 3 && recentEvents.length >= 1) {
    return true  // context 壓力 + 剛 truncation = 極可能螺旋
  }
  
  return false
}
```

**死亡螺旋發生後的行為：**

- `state.deathSpiral = true`，`state.recoveryState = 'stopped'`
- 不再 inject 任何 recovery prompt
- 僅持續記錄 todo 狀態到 persistence（被動等待使用者）
- 若使用者手動下指令 → `deathSpiral = false`（使用者恢復控制權）

#### 8e. 復原品質信號

復原「成功」不代表「做對」。驗證 timer 只確認 model 有 tool call，但可能是錯的 tool。

```javascript
function assessRecoveryQuality(sessionID, toolEvent) {
  const state = states.get(sessionID)
  if (!state || state.recoveryState !== 'verified') return
  
  // Signal 1: 重複截斷前的 tool？（可能還在 loop）
  if (state.lastToolBeforeTruncation &&
      toolEvent.name === state.lastToolBeforeTruncation &&
      state.repeatedToolCount > 3) {
    state.recoveryQuality = 'confused'
    log(`[WARN] [${sessionID}] recovery quality: confused (repeating ${toolEvent.name})`)
    return
  }
  
  // Signal 2: 復原後立即 error？
  if (toolEvent.status === 'error') {
    state.recoveryQuality = 'confused'
    log(`[WARN] [${sessionID}] recovery quality: confused (immediate error)`)
    return
  }
  
  // Signal 3: 復原後做了有意義的 tool call（非重複、非錯誤）
  state.recoveryQuality = 'good'
}
```

品質信號在 Phase 1 僅記錄不動作。Phase 2 可根據品質調整 inject 策略。

#### 8f. Pre-Recovery Context Pressure Check

注入 recovery prompt 前檢查 context 壓力：

```javascript
function shouldAttemptRecovery(sessionID) {
  const state = states.get(sessionID)
  if (!state) return false
  
  // 硬性停止條件
  if (state.recoveryState === 'stopped') return false
  if (state.deathSpiral) return false
  if (state.recoveryAttempts >= config.maxRecoveryAttempts) return false
  
  // Context 壓力檢查：壓力過高時 recovery 幫助有限
  if (state.contextWarnings >= 3) {
    log(`[WARN] [${sessionID}] context pressure too high (${state.contextWarnings}), skip recovery`)
    return false
  }
  
  // 處理中 guard：模型還在 processing 上次注入
  if (state.processingGuard) {
    log(`[WARN] [${sessionID}] processing guard active, skip recovery`)
    return false
  }
  
  // In-flight tool：模型在等 tool 回傳
  if (state.waitingForTool) {
    return false
  }
  
  return true
}
```

### 復原反饋迴圈的 event flow

```
tool.completed (todowrite → todos changed)
  ↓
detectTruncation()
  ├─ 未發生 truncation → 正常續行檢查（既有的 stuck/tool error/…）
  └─ 發生 truncation →
       ├─ shouldAttemptRecovery() → false → 跳過，只更新 persistence
       └─ shouldAttemptRecovery() → true →
            executeRecovery()
              ├─ persistState() → 先存檔
              ├─ selectPromptLevel() → 根據 recoveryLevel 選擇 prompt
              ├─ injectPrompt() → 注入
               ├─ startRecoveryVerification(sessionID, config) → 啟動雙階段 timer
              └─ state.recoveryState = 'injected'
                    │
                    ▼  (等待)
                    ├─ tool.started fires →
                    │     clearRecoveryVerification()
                    │     handleRecoverySuccess()
                    │     assessRecoveryQuality()
                    │     detectDeathSpiral()
                    │     state.recoveryState = 'verified' (or keep going)
                    │
                    └─ timer expiry (stage2) →
                          handleRecoveryFailure()
                            ├─ detectDeathSpiral() → true → stopped
                            └─ recoveryLevel++ → executeRecovery() → 升級重試
```

---

## 關鍵功能 9: Tool 錯誤分級與智能應對

### 問題：當前 tool error 處理是「平的」

現狀：不管錯 1 次還是錯 10 次，都是用同一種語氣告訴模型「換個方法」。

但 Gemma-4 4B 的特性決定了不同錯誤次數需要不同策略：

| 錯誤次數 | 模型心理狀態                 | 需要什麼                      |
| -------- | ---------------------------- | ----------------------------- |
| 1-2 次   | 只是運氣不好，再試一次       | 簡單 retry，注意語法          |
| 3-5 次   | 目前方法不對，需要換方向     | 明確要求使用完全不同方法      |
| 6+ 次    | LLM 不知道正確解法，需要外力 | 要求使用 websearch 查解決方案 |

### 解決方案：四級錯誤升級機制

#### 9a. Tool Error Pattern Analyzer

```javascript
function analyzeToolErrors(state, config) {
  const history = state.toolCallHistory || []
  const errors = history.filter(t => t.status === 'error')
  
  if (errors.length === 0) return { level: 0, pattern: 'none', toolType: null }
  
  // 最近 10 筆中哪些 tool 在錯
  const recent = history.slice(-10)
  const recentErrors = recent.filter(t => t.status === 'error')
  const errorCount = recentErrors.length
  
  // 分析錯誤模式
  const errorToolNames = [...new Set(recentErrors.map(t => t.name))]
  const singleToolPattern = errorToolNames.length === 1
  
  // 判斷是否同一 tool 連續失敗
  const lastTool = history[history.length - 1]
  const consecutiveSameTool = lastTool && lastTool.status === 'error' &&
    history.slice(-Math.min(errorCount, 10)).every(t => 
      t.status === 'error' && t.name === lastTool.name
    )
  
  // 判定錯誤等級
  let level = 0
  if (errorCount >= 7) level = 4       // 搜尋網路
  else if (errorCount >= 4) level = 3  // 完全換方法
  else if (errorCount >= 2) level = 2  // 換方法
  else if (errorCount >= 1) level = 1  // 重試
  
  return {
    level,
    pattern: singleToolPattern ? 'single_tool' : 'multi_tool',
    toolType: errorToolNames.length === 1 ? errorToolNames[0] : 'mixed',
    errorCount,
    consecutiveSameTool,
    lastErrorTool: lastTool?.name || null
  }
}
```

#### 9b. State 擴充（Tool 錯誤分析）

```javascript
// ===== Tool 錯誤進階分析 (NEW) =====
toolErrorAnalysis: {              // 上一次分析的結果
  level: 0,                       // 0-4 錯誤等級
  pattern: 'none',                // 'none' | 'single_tool' | 'multi_tool'
  toolType: null,                 // 正在出錯的 tool name
  errorCount: 0,                  // 最近 10 筆中錯誤數
  consecutiveSameTool: false,     // 是否連續同一 tool 失敗
  lastErrorTool: null
},
toolErrorsByTool: {},             // {toolName: count} 逐 tool 錯誤統計
webSearchSuggested: false,        // 此 session 是否已建議搜尋網路
lastErrorEscalationTime: 0,       // 上次升級時間，防止短時間內重複升級
```

#### 9c. 分級續行提示模板

**Level 1 (1 次錯誤 — 重試並注意語法)：**

```
[續行] tool 失敗。重試任務「{task}」，注意指令語法。直接執行。
```

**Level 2 (2-3 次錯誤 — 換方法)：**

```
[續行] tool 失敗 {N} 次。換個方法做「{task}」。不要重複同一 tool。直接執行。
```

**Level 3 (4-6 次錯誤 — 完全換方向)：**

```
[續行] tool 一直失敗。用完全不同方法做「{task}」。
如果原本用 bash，改用 write；如果原本用 edit，改用 read+write。
不要再用 {lastTool}。直接執行。
```

**Level 4 (7+ 次錯誤 — 搜尋網路)：**

```
[續行] tool 持續失敗 {N} 次。你目前的方法不對。
先用 websearch 搜尋解決方案，理解正確做法後再執行。
不要猜，不要重複同一個 tool。搜尋後再繼續。
```

#### 9d. Tool 類型感知提示

不同 tool 的錯誤需要不同建議：

```javascript
function buildToolEscalationPrompt(analysis, task, state) {
  const { level, toolType, errorCount } = analysis
  
  if (level <= 1) {
    return `[續行] tool 失敗。重試任務「${task}」，注意指令語法。直接執行。`
  }
  
  // Level 2-3: tool-type aware
  if (level <= 3) {
    switch (toolType) {
      case 'bash':
        return `[續行] bash 失敗 ${errorCount} 次。改用不同指令，`
          + `或改用 write 產生腳本檔案再執行。`
          + `不要重複同一指令。直接執行。`
      case 'edit':
        return `[續行] edit 失敗 ${errorCount} 次。先用 read 確認檔案內容，`
          + `確認行號無誤後再 edit。或改用 write 覆蓋整個檔案。直接執行。`
      case 'write':
        return `[續行] write 失敗 ${errorCount} 次。確認目錄是否存在，`
          + `或改用 bash mkdir 建立目錄後再 write。直接執行。`
      default:
        return `[續行] tool ${toolType} 失敗 ${errorCount} 次。`
          + `換完全不同方法做「${task}」。直接執行。`
    }
  }
  
  // Level 4: web search
  if (!state.webSearchSuggested) {
    state.webSearchSuggested = true
    return `[續行] tool 持續失敗 ${errorCount} 次。你目前的方法不對。`
      + `先用 websearch 搜尋「${task}」的正確做法，`
      + `理解後再執行。不要猜，不要重複失敗的 tool。`
  }
  
  // Already suggested web search, still failing → full stop
  return `[續行] 搜尋後仍然失敗。請改用完全不同的方法處理「${task}」。`
    + `或考慮將任務拆成更小的步驟。`
}
```

#### 9e. 錯誤等級死亡螺旋增強

原本 death spiral 只看 truncation 頻率。但 **tool 錯誤也會導致 context 膨脹**（錯誤訊息佔空間）→ truncation → 更頻繁的 tool 錯誤。

```javascript
function detectDeathSpiral(state, now = Date.now()) {
  const windowStart = now - config.deathSpiralWindowMs
  
  // === 原有：truncation 頻率 ===
  const recentEvents = state.truncationEvents.filter(e => e.time >= windowStart)
  if (recentEvents.length >= config.deathSpiralThreshold) return true
  
  // === 原有：連續失敗 ===
  const recentFailures = recentEvents.filter(e => e.success === false)
  if (recentFailures.length >= 2) return true
  
  // === 原有：context 壓力 ===
  if (state.contextWarnings >= 3 && recentEvents.length >= 1) return true
  
  // === NEW: Tool 錯誤螺旋 ===
  // 大量 tool 錯誤 + 已有 truncation = 極可能惡性循環
  if (state.toolErrorAnalysis?.level >= 3 && recentEvents.length >= 1) {
    // 錯誤訊息塞爆 context → truncation → 忘記如何正確使用 tool → 繼續錯
    return true
  }
  
  // === NEW: 同一 tool 大量錯誤 ===
  if (state.toolErrorAnalysis?.consecutiveSameTool && 
      state.toolErrorAnalysis?.errorCount >= 5) {
    return true  // 同一 tool 連錯 5 次 = 模型不會用這個 tool
  }
  
  return false
}
```

#### 9f. 與既有 injector 的整合

```javascript
function determinePromptType(state, todos, config) {
  // 優先級 1: Recovery（最高優先級）
  if (state.recoveryState !== 'idle') return 'recovery'
  
  // 優先級 2: Tool 錯誤（依等級分級）
  const errorAnalysis = analyzeToolErrors(state, config)
  state.toolErrorAnalysis = errorAnalysis
  if (errorAnalysis.level >= 1) {
    if (errorAnalysis.level >= 4) return 'tool_error_search'    // NEW
    if (errorAnalysis.level >= 2) return 'tool_error_escalated' // NEW
    return 'tool_error'
  }
  
  // 優先級 3: Context 壓力
  if (state.contextWarnings >= 3) return 'context_pressure'
  
  // 優先級 4: 卡住
  if (checkStuckState(state, todos)) return 'stuck'
  
  // 優先級 5: 正常續行
  return 'normal'
}
```

#### 9g. Injector Routing Matrix — 從 promptType 到具體模板

`determinePromptType()` 輸出 prompt type 後，需經過路由矩陣解析為具體提示文字：

```javascript
// Routing Matrix: promptType × promptStyle × escalationLevel → template selector
const INJECTOR_ROUTES = {
  recovery:           { needsLevel: true,  styleAware: true,  templateGroup: 'recovery' },
  tool_error:         { needsLevel: true,  styleAware: true,  templateGroup: 'toolError' },
  tool_error_escalated: { needsLevel: true,  styleAware: true,  templateGroup: 'toolError' },
  tool_error_search:  { needsLevel: false, styleAware: true,  templateGroup: 'toolError' },
  context_pressure:   { needsLevel: false, styleAware: true,  templateGroup: 'context' },
  stuck:              { needsLevel: false, styleAware: true,  templateGroup: 'stuck' },
  normal:             { needsLevel: false, styleAware: true,  templateGroup: 'continuation' },
}

function selectPromptTemplate(promptType, promptStyle, level, state, todos) {
  const route = INJECTOR_ROUTES[promptType]
  if (!route) return ''
  const group = PROMPT_STYLES[promptStyle]
  if (!group) return ''

  if (route.templateGroup === 'recovery') {
    // 4 級 recovery prompt, clamp 0-3
    const lvl = Math.min(Math.max(level || 0, 0), 3)
    if (lvl === 0) return group.recoveryL0
    if (lvl === 1) return group.recoveryL1
    if (lvl === 2) return group.recoveryL2
    return buildFullRecoveryPrompt(todos, state, promptStyle) // level 3
  }

  if (route.templateGroup === 'toolError') {
    if (!route.needsLevel) return group.toolErrorL4 // search 固定 level 4
    const lvl = Math.min(Math.max(level || 1, 1), 4)
    let tpl = group[`toolErrorL${lvl}`] || group.toolErrorL1
    if (level >= 3 && state.toolErrorAnalysis?.toolType) {
      tpl = tpl.replace('{suggestion}', buildTypeSuggestion(state.toolErrorAnalysis.toolType))
    }
    return tpl
  }

  if (route.templateGroup === 'context') return group.contextPressure
  if (route.templateGroup === 'stuck')   return group.stuck
  return group.continuation
}

// 模板變數替換
function fillTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] !== undefined ? vars[k] : `{${k}}`)
}

// 最終注入 prompt 生成入口
function buildInjectPrompt(state, todos, config) {
  const promptType = determinePromptType(state, todos, config)
  const promptStyle = getPromptStyle(config)
  const errorLevel = state.toolErrorAnalysis?.level || 0
  return selectPromptTemplate(promptType, promptStyle, errorLevel, state, todos)
}
```

**路由流程：** `promptType → route lookup → style lookup → level clamp → template select → fill → output`。共 7 種 promptType × 2 種 style × 4 級 escalation = 最多 56 種有效組合，每種有明確 fallback。

#### 9h. 實作整合示意

    └─ level 0 → 其他續行檢查

```
---

每層獨立 try/catch，一層壞了不影響其他層。

### Layer 1-6, 8: 與原有相同（20 點）

| Layer | 情境 | 處理 |
|-------|------|------|
| 1-Init | fs/目錄/config/log/未知 event | 預設值、靜默降級 |
| 2-Event | undefined property/unknown type/handler crash | Optional chaining + try/catch |
| 3-Tool | 孤兒 started/completed/多 tool/undefined name | Timeout/ignore/unknown fallback |
| 3-Tool | toolErrorAnalysis 計算失敗 (NEW) | 降級為 level 0，不影響 injector 決策 |
| 4-State | 遺失 state/undefined 欄位/Map 堆積 | 預設值 || + 定期清理 |
| 5-Persist | 寫檔失敗/讀檔損毀/目錄不存在/檔案殘留 | 降級 in-memory/自動建立/清理 |
| 6-Inject | prompt 失敗/session 消失/模型無回應 | counter → stop/clean state/guard |
| 8-Timer | 重複 timer/未清理 timer/疊加 | guard/clearAll |

### Layer 7: 復原狀態機 + 使用者介入專用（14 點，原有 3 + 新增 11）

| 情境 | 處理 |
|------|------|
| 截斷→復原→截斷循環 | recoveryAttempts++ → >=maxRecoveryAttempts → STOPPED |
| persistence 跟著循環 | recoveryAttempts 寫入檔案 |
| 復原後又卡住 | stuck detector 接手 |
| **復原驗證 timer 失效** | setTimeout callback 內檢查 state 是否存在 + recoveryState 是否仍是 'injected' |
| **死亡螺旋殘留** | session.deleted 或使用者訊息時重置 deathSpiral flag |
| **提示層級超出範圍** | level 計算 clamp(0, 3)，超過 3 視同 stopped |
| **Recovery 進行中收到新 truncation** | 記錄 truncationEvents 但不觸發新 cycle (interleaving rule 1) |
| **使用者介入 (intervention)** | message.completed user role → full state reset + cooldown (rule 2) |
| **Session ID 含特殊字元** | sanitizeSessionID() 過濾 |
| **States Map 超過上限** | LRU eviction，最多 50 個 session |
| **Config 驗證失敗** | log 錯誤，使用全預設值 |
| **heartbeatDisabled 時收到事件** | 記錄但不 inject (shouldSkipInjection guard) |
| **cooldown 期間收到 inject 請求** | 跳過 inject，等待 cooldown 結束 |
| **使用者命令解析失敗** | handleUserCommand 回傳 null → 不動作 |

```javascript
// Timer callback guard (Layer 7, point 1)
// recoveryVerification timer 觸發時：
function recoverVerificationCallback(sessionID) {
  const state = states.get(sessionID)
  // Guard: session 可能已消失
  if (!state) return
  // Guard: recoveryState 可能已變（例如使用者手動中斷）
  if (state.recoveryState !== 'injected') return
  // ... 實際 failure 處理
}
```

---

## 架構圖（更新版：含 recovery state machine）

```
┌─────────────────────────────────────────────────────────────────────┐
│                     smart-heartbeat-local.js                         │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐           │
│  │  Event       │  │  Prompt      │  │  In-Flight Tool  │           │
│  │  Router      │──│  Processing  │──│  Tracker         │           │
│  │  (8 types)   │  │  Guard       │  │  (task/bash/…)   │           │
│  └──────┬───────┘  └──────────────┘  └────────┬─────────┘           │
│         │                                      │                     │
│  ┌──────▼──────────────────────────────────────▼─────────┐          │
│  │                 Detection Engine                        │          │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────┐   │          │
│  │  │ Stuck    │  │ Context  │  │ Truncat- │  │ Tool │   │          │
│  │  │ Detector │  │ Pressure │  │ ion Detect│  │Error │   │          │
│  │  │(todo+tool│  │ Monitor  │  │(3 methods)│  │Cntr  │   │          │
│  │  │ +idle)   │  │          │  │          │  │      │   │          │
│  │  └──────────┘  └──────────┘  └─────┬────┘  └──────┘   │          │
│  └─────────────────────────────────────┼──────────────────┘          │
│                                        │                              │
│  ┌─────────────────────────────────────▼────────────────────────┐    │
│  │           Recovery State Machine (NEW)                        │    │
│  │                                                                │    │
│  │  IDLE → PRE-CHECK → INJECT → VERIFICATION →                   │    │
│  │    ├─ tool.started → VERIFIED → QUALITY CHECK → IDLE          │    │
│  │    └─ timer expiry → FAILED →                                  │    │
│  │         ├─ escalation → INJECT (升級重試)                      │    │
│  │         └─ max attempts → STOPPED                              │    │
│  │                                                                │    │
│  │  Death spiral detection embedded across all transitions        │    │
│  └──────────────────────────────┬─────────────────────────────────┘    │
│                                 │                                      │
│  ┌──────────────────────────────▼─────────────────────────────────┐   │
│  │              Continuation Injector                              │   │
│  │  (5 prompt types: normal/error/stuck/truncation/ctx             │   │
│  │   + 4 progressive recovery levels)                              │   │
│  │  + agent routing + state context injection                      │   │
│  └──────┬─────────────────────────────────────────────────────────┘   │
│         │                                                             │
│  ┌──────▼─────────────────────────────────────────────────────────┐   │
│  │              Error Handling (37 guards)                         │   │
│  │  >9 layers: Start failover→Init→Event→Tool→State→Persist→Inject→Recovery→Timer │   │
│  │  →Recovery→Timer. Each layer independent.                       │   │
│  │  +7 NEW guards: sanitize/LRU/config/type/interleave/reset/crash │   │
│  └──────┬─────────────────────────────────────────────────────────┘   │
│         │                                                             │
│  ┌──────▼───────┐                                                     │
│  │  Progress    │                                                     │
│  │  Persister   │──▶ .opencode/heartbeat-state/                      │
│  │  (debounced) │──▶ atomic write + stale cleanup                    │
│  └──────────────┘                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 關鍵假設與風險

以下假設在 Phase 1 實作前必須驗證。若假設錯誤，核心設計需調整。

### 假設 1: client.session.prompt 語意

**假設為 APPEND 模式** — 以 user message 附加到現有 context，不取代既有內容。

| 實際模式                | 對設計的影響                      | 應對方案                                            |
| ----------------------- | --------------------------------- | --------------------------------------------------- |
| APPEND (假設正確)       | 漸進提示 Level 0-3 正確，越低越好 | 無變更                                              |
| REPLACE (取代 context)  | 漸進提示的 context 成本差異消失   | Level 0-3 統一改為完整狀態注入，移除 Level 選擇邏輯 |
| INJECT (system message) | 最理想，不佔 user/assistant 位置  | 降低 Level 0 至空觸發（僅喚醒不注入）               |

**驗證方式：** Phase 1 第一步寫最小測試 plugin，確認以下 API 簽名與行為：

```javascript
// === 最小驗證 plugin (verify-api.js, ~50 行) ===
// 目標: 確認 4 個未知 API 的行為，結果決定 main plugin 的設計

module.exports = {
  onStart: async (opencode, client) => {
    const results = { promptMode: null, events: {}, showToast: false, modelName: null }

    // 1. 驗證 client.session.prompt 語意
    //    注入兩次不同訊息，檢查 context 是否同時存在兩者
    await client.session.prompt({ message: '第一條測試訊息', sessionID: 'test-ses' })
    await client.session.prompt({ message: '第二條測試訊息', sessionID: 'test-ses' })
    // → 人工檢查系統 log: 若兩條都存在 ≡ APPEND；僅存在最後一條 ≡ REPLACE
    // → 在 Phase 1 main plugin 實作前人工檢查一次即可
    results.promptMode = '待人工確認 (查看 log 中 context 內容)'

    // 2. 驗證 event payload 結構
    const eventSamples = {}
    const off = [
      client.on('tool.started', d => { eventSamples['tool.started'] = Object.keys(d) }),
      client.on('tool.completed', d => { eventSamples['tool.completed'] = Object.keys(d) }),
      client.on('message.completed', d => { eventSamples['message.completed'] = Object.keys(d) }),
    ]
    // 觸發一個 tool call 來收集 payload
    // 執行 bash 'echo api-verify' 應會觸發 tool.started + tool.completed
    // 輸出結構記錄到 eventSamples，用於 main plugin 的 handler 實作
    setTimeout(() => off.forEach(f => f()), 10000)
    
    // 3. 驗證 showToast
    results.showToast = typeof opencode?.showToast === 'function'
    
    // 4. 驗證模型名稱取得
    results.modelName = opencode?.session?.model || opencode?.config?.model || null

    // 輸出結果
    console.log('[API-VERIFY]', JSON.stringify(results, null, 2))
  }
}
```

**通過標準：**

| API                      | 預期結果               | 若不符的影響                               |
| ------------------------ | ---------------------- | ------------------------------------------ |
| `client.session.prompt`  | APPEND                 | 漸進提示層級 redesign                      |
| `tool.started` payload   | 含 `name`, `sessionID` | event handler 全部改寫                     |
| `showToast`              | function exists        | /heartbeat status 改寫入 assistant message |
| `opencode.session.model` | string                 | auto-detect 改用 env fallback              |

### 假設 2: OpenCode 不提供 Compaction Event

假設需從 todo 變化側面推測 truncation。

若 OpenCode 提供 `compaction:started` / `compaction:completed` event：

- 直接用 event 偵測，可靠度大幅提升
- 現有三種 todo-based 偵測方法降級為備援

**驗證方式：** 查 OpenCode source code 或 log 中 `compaction` 關鍵字。

### 假設 3: Context Size 無法取得

假設需透過 tool call 次數推估 context size。

若 OpenCode API 提供 `session.contextSize` 或 `session.remainingTokens`：

- Adaptive timeout 和 verification timer delay 更精確
- 推估演算法降級為備援

**驗證方式：** 查 OpenCode API 文件或 `opencode.session` 物件。

### 假設 5: Todo 讀取 API

假設 OpenCode 提供某種方式讀取當前 todo list。Plugin 的 injector 需要 todos 才能知道要續行哪個任務、剩多少任務。

| 可能 API                    | 優先級    | 預期回傳格式                             |
| --------------------------- | --------- | ---------------------------------------- |
| `client.session.getTodos()` | Primary   | `Promise<[{content, status, priority}]>` |
| `opencode.session.todos`    | Secondary | `[{content, status, priority}]`          |
| 無直接 API                  | Fallback  | 從 persistence 檔案推測                  |

**驗證方式：** 在 `verify-api.js` 中加入第 5 項檢查（見下方程式碼）。試用所有可能的 todo 讀取方式，記錄哪個可用。

```javascript
// verify-api.js 第 5 項
results.todoAPIs = {}
// Try client.session.getTodos
try {
  if (typeof client?.session?.getTodos === 'function') {
    const todos = await client.session.getTodos()
    results.todoAPIs['client.session.getTodos'] = Array.isArray(todos) ? 'works' : 'wrong type'
  }
} catch (e) { results.todoAPIs['client.session.getTodos'] = `error: ${e.message}` }
// Try opencode.session.todos
try {
  const todos = opencode?.session?.todos
  results.todoAPIs['opencode.session.todos'] = Array.isArray(todos) ? 'works' : 'not available'
} catch (e) { results.todoAPIs['opencode.session.todos'] = `error: ${e.message}` }
```

**若不符的影響與應變方案：**

| 驗證結果                         | 影響                         | 應變方案                                                     |
| -------------------------------- | ---------------------------- | ------------------------------------------------------------ |
| `client.session.getTodos()` 可用 | 最理想，精準知道任務狀態     | 無變更                                                       |
| `opencode.session.todos` 可用    | 同步讀取，不需 async adapter | adapter 改用此路徑                                           |
| 兩者都不可用                     | 無法直接知道當前任務         | 全部從 persistence 快取推測，精準度下降（因 debounce 可能過時） |

**Persistence fallback 需注意：** 若 fallback 是最終方案，state persistence 的 debounce 時間需從 5s 降到 1s，並在 `handleToolCompleted` 後立即 flush，確保 truncation 前 state 已寫入。

---

## 設定檔結構 (opencode.json)

```json
{
  "plugins": ["smart-heartbeat-local"],
  "heartbeat": {
    "enabled": true,
    "modelScale": "auto",     // 'auto' | 'small' | 'medium'
    "profiles": {
      "small": {               // 自訂 small tier 的參數
        "promptSpeedTps": 80,
        "effectiveMaxContext": 48000,
        "countdownSeconds": 25
      }
    },
    "promptSpeedTps": 50,
    "effectiveMaxContext": 32000,
    "countdownSeconds": 30,
    "minIntervalMs": 90000,
    "maxStuckCycles": 8,
    "maxToolErrors": 8,
    "maxRepeatedTool": 10,
    "maxIdleSeconds": 120,
    "maxRecoveryAttempts": 3,
    "recoveryVerificationMaxMs": 60000,
    "deathSpiralWindowMs": 300000,
    "deathSpiralThreshold": 3,
    "logLevel": "warn",
    "toolTimeout": {
      "task": 300,
      "bash": 120,
      "edit": 60,
      "read": 30,
      "default": 60
    },
    "persistence": {
      "maxFiles": 100,
      "cleanupAgeHours": 24,
      "debounceMs": 5000
    }
  }
}
```

所有欄位皆為 optional，plugin 有完整預設值。

### Config 生命週期

```
plugin onStart → loadConfig(opencode) → validateConfig(config) →
  detectModelProfile(opencode) → resolveScaleTier(config, detected) →
  freeze(config) → ...
  運行中修改 opencode.json 不生效，需重啟 OpenCode
```

### Model Scale 系統：跨模型支援

不同的 local LLM 參數差異極大。目前支援兩種內建 scale：

| scale  | 模型舉例                                                    | 有效 Context | Tool Calling | 適合的 Prompt 風格     |
| ------ | ----------------------------------------------------------- | ------------ | ------------ | ---------------------- |
| small  | Gemma-4 4B, Phi-4 7B, Llama-3.2 3B                          | ~32K         | 弱           | ultra_short — 極簡強勢 |
| medium | Qwen3.5 14B, Mistral 12B, DeepSeek-Coder 16B, Llama-3.1 70B | ~64K         | 中           | short — 簡短明確       |

> **注意：** 此 plugin 專為輔助中小型 local LLM 設計。大型模型（32B+）如 Qwen3.6 32B、Llama-3.1 70B 等本身推理能力強、tool calling 可靠，理論上不需要此類輔助。但若仍想使用，auto-detect 會將其歸入 `medium` tier。

#### Scale 設定（以 MODEL_SCALE_TIERS 取代舊版 MODEL_PROFILES）

過去使用硬編碼的 `MODEL_PROFILES`（gemma-4-4b / qwen3.5-14b / qwen3.6-32b），現在統一改為參數量級分級 `MODEL_SCALE_TIERS`（small / medium），任何模型只要名稱含參數數值即自動對應。

```
#### 自動模型偵測 (Auto-Detect)

使用者不需要手動設定 `modelScale`。Plugin 啟動時從模型名稱的參數量級自動偵測：

```javascript
// 二級設定量表：依規模調整參數 (取代舊版硬編碼 MODEL_PROFILES)
// 此 plugin 專為輔助中小型 local LLM 設計，只設 small/medium 兩級
const MODEL_SCALE_TIERS = {
  'small': {    // < 10B params — 最保守設定
    promptSpeedTps: 50, effectiveMaxContext: 32000,
    countdownSeconds: 30, minIntervalMs: 90000,
    maxStuckCycles: 8, maxToolErrors: 8, maxRepeatedTool: 10,
    maxIdleSeconds: 120, maxRecoveryAttempts: 3,
    recoveryVerificationMaxMs: 60000, deathSpiralThreshold: 3,
    promptStyle: 'ultra_short',
  },
  'medium': {   // >= 10B params — 適中設定
    promptSpeedTps: 120, effectiveMaxContext: 64000,
    countdownSeconds: 20, minIntervalMs: 60000,
    maxStuckCycles: 5, maxToolErrors: 5, maxRepeatedTool: 8,
    maxIdleSeconds: 90, maxRecoveryAttempts: 2,
    recoveryVerificationMaxMs: 45000, deathSpiralThreshold: 4,
    promptStyle: 'short',
  },
}

// 從模型名稱正則解析參數數值 (e.g., "llama-4-12b" → 12B → 'medium')
// ⚠️ Edge case: "mixtral-8x7b" — 跳過 MoE 模式 ("digit+x+digit+b"),
// 否則 "8" 會 match 到 "8b" → small, 但實際 Mixtral 8x7B ≈ 47B。
// MoE 模型由 detectModelScale 的 family default (mixtral → medium) 處理。
function parseParamCountFromModelName(modelName) {
  if (typeof modelName !== 'string') return null
  // 跳過 "8x7b" 這類 MoE 模式
  if (/\d+x\d+\s*b/i.test(modelName)) return null
  const match = modelName.match(/(\d+\.?\d*)\s*b/i)
  if (!match) return null
  const count = parseFloat(match[1])
  return (count < 10) ? 'small' : 'medium'
}

// 完整模型名稱 → 量級 (支援參數數值 + 已知家族預設)
function detectModelScale(modelName) {
  if (typeof modelName !== 'string') return null
  // Priority 1: 正則解析 (通用，適用任何品牌，MoE 模型跳過)
  const fromParam = parseParamCountFromModelName(modelName)
  if (fromParam) return fromParam
  // Priority 2: 已知模型家族預設 (處理 MoE 等不含明確參數數值的模型)
  const lower = modelName.toLowerCase()
  if (lower.includes('gemma') || lower.includes('phi')) return 'small'
  if (lower.includes('llama') || lower.includes('mistral')
    || lower.includes('mixtral') || lower.includes('deepseek')
    || lower.includes('qwen') || lower.includes('yi')) return 'medium'
  return null
}

// 主要入口：決定使用哪個 scale tier
function detectModelProfile(opencode) {
  const explicitScale = opencode?.config?.heartbeat?.modelScale
  if (explicitScale && explicitScale !== 'auto') {
    if (MODEL_SCALE_TIERS[explicitScale]) return explicitScale
  }
  const modelName = opencode?.session?.model || opencode?.config?.model || process.env.OPENCODE_MODEL
  if (modelName) {
    const matched = detectModelScale(String(modelName))
    if (matched && MODEL_SCALE_TIERS[matched]) return matched
  }
  return 'small'  // Fallback: 最保守
}
```

**偵測邏輯：**

```
plugin onStart → detectModelProfile(opencode) →
  ├─ 使用者設 modelScale=medium → 直接採用 (跳過 auto-detect)
  ├─ auto-detect 從模型名稱成功 → 使用對應 tier (不需使用者設定)
  └─ auto-detect 失敗 (未知模型) → small (最保守，保證可用)
```

auto-detect 的結果可被 config 中顯式 `modelScale` 覆蓋（當 auto-detect 猜錯時）。

> **只有兩級的原因：** 此 plugin 是為無法像 cloud LLM 一樣聰明判斷的中小型 model 設計。大型模型（30B+）如 Qwen3.6 32B、Llama-3.1 70B 等無需此輔助。若仍想使用，會歸入 `medium`。

#### Config 合併順序

```
1. MODEL_SCALE_TIERS 內建預設值 (fallback)
2. auto-detect modelScale 覆蓋 (自動，使用者無感)
3. 使用者的 profiles['small'|'medium'] 覆蓋 (若存在手動設定)
4. 使用者在 heartbeat.* 的顯式設定覆蓋 (最高優先級，完全手動控制)
```

**使用者 opencode.json 範例（完全不用設定 modelScale）：**

```json
{
  "heartbeat": {
    // modelScale 不設 (或 "auto") → auto-detect 自動偵測
    // 僅在 auto-detect 猜錯時才需手動指定
    "profiles": {
      "medium": {
        "promptSpeedTps": 140,
        "maxToolErrors": 4
      }
    },
    "countdownSeconds": 25
  }
}
```

> **注意：** `profiles` 的 key 必須是 scale tier 名稱（`small` | `medium`），對應目前 auto-detect 的結果。只有匹配的 profile 才會被合併。

→ 最終：auto-detect 判定為 medium，`countdownSeconds` = 25 (override)，`maxToolErrors` = 4 (custom profile)，其餘從 `MODEL_SCALE_TIERS.medium` 取用。

#### PromptStyle 兩種模式

不同模型能理解的 prompt 長度不同，plugin 據此選擇模板。大模型（30B+）不需此 plugin 輔助，故只保留兩種：

| Style         | 用途                    | 範例                        |
| ------------- | ----------------------- | --------------------------- |
| `ultra_short` | small (如 Gemma-4 4B)   | `繼續` / `繼續任務`         |
| `short`       | medium (如 Qwen3.5 14B) | `繼續任務` / `繼續: {task}` |

> ⚠️ **以下 PROMPT_STYLES 僅供設計參考。**
> 實際實作以 `01-foundation.md` Task 1.5 為準，該處是唯一 canonical 來源。
> 此處保留以利對照設計意圖，但修改 prompt 模板時請修改 `01-foundation.md`。

```javascript
// ⚠️ REFERENCE ONLY — canonical at 01-foundation.md Task 1.5
// 以下為完整 7 種模板類型（包含 contextPressure 與 stuck）
const PROMPT_STYLES = {
  'ultra_short': {
    continuation: '[續行] 還有 {n} 項。下一項：{task} 直接執行。完成用 todowrite。不要問。',
    toolErrorL1: '[續行] tool 失敗。重試 {task}。直接執行。',
    toolErrorL2: '[續行] tool 失敗 {n} 次。換方法做 {task}。不要重複。直接執行。',
    toolErrorL3: '[續行] tool 一直失敗。不用 {lastTool}，換全新方法。直接執行。',
    toolErrorL4: '[續行] tool 一直失敗。用 websearch 查解法。不要猜。',
    recoveryL0: '繼續',
    recoveryL1: '繼續任務',
    recoveryL2: '繼續: {task}',
    contextPressure: '[續行] context 壓力大。任務餘 {n}。{task} 直接完成，避免大型輸出。',
    stuck: '[續行] 卡住。換全新方法做 {task}。不要重複。直接執行。',
  },
  'short': {
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
```

#### 選擇邏輯

```javascript
function getPromptStyle(config) {
  // config.modelScale 在 loadConfig 時已解析為 'small'|'medium'
  const scale = config.modelScale || 'small'
  const tier = MODEL_SCALE_TIERS[scale] || MODEL_SCALE_TIERS['small']
  return PROMPT_STYLES[tier?.promptStyle || 'ultra_short'] || PROMPT_STYLES['ultra_short']
}
```

所有既有 prompt templates 改為從 `getPromptStyle(config)` 動態讀取，不再硬編碼。

### 硬編碼零容忍原則

Phase 1 目標：**0 個硬編碼常數。** 所有數值參數皆可透過 config 覆蓋。

共 22 個可設定參數（含 modelScale 切換器）。標示「依 scale」表示該值由 `MODEL_SCALE_TIERS` 決定但可在 `heartbeat.*` 顯式覆蓋：

| 參數                        | 預設值        | 用途                                               |
| --------------------------- | ------------- | -------------------------------------------------- |
| `modelScale`                | `"auto"`      | 選擇 scale: auto \| small \| medium                |
| `profiles`                  | `{}`          | 自訂 scale 覆寫 (profiles.small / profiles.medium) |
| `promptStyle`               | 依 scale      | `ultra_short` \| `short`                           |
| `promptSpeedTps`            | 依 scale      | Prompt processing 速度 (tok/s)                     |
| `effectiveMaxContext`       | 依 scale      | 有效 context 上限 (tokens)                         |
| `countdownSeconds`          | 依 scale      | 基礎倒數                                           |
| `minIntervalMs`             | 依 scale      | 兩次續行最小間隔                                   |
| `maxStuckCycles`            | 依 scale      | 無進度判定門檻                                     |
| `maxToolErrors`             | 依 scale      | 連續 tool 錯誤上限                                 |
| `maxRepeatedTool`           | 依 scale      | 重複 tool 呼叫上限                                 |
| `maxIdleSeconds`            | 依 scale      | 無活動閒置上限                                     |
| `maxRecoveryAttempts`       | 依 scale      | 復原嘗試次數上限                                   |
| `recoveryVerificationMaxMs` | 依 scale      | 驗證 timer 最大等待時間                            |
| `deathSpiralWindowMs`       | 300000 (不變) | 死亡螺旋時間窗口                                   |
| `deathSpiralThreshold`      | 依 scale      | 死亡螺旋觸發次數                                   |
| `logLevel`                  | `"warn"`      | 日誌級別                                           |
| `toolTimeout.*`             | 參照上表      | 各 tool 超時秒數                                   |
| `persistence.*`             | 參照上表      | 持久化設定                                         |

**「依 scale」表示該值由 `MODEL_SCALE_TIERS[scale]` 決定，但使用者可在 `heartbeat.*` 顯式覆蓋。**
切換 `modelScale` 即自動切換整組參數，單一參數 override 可精細調整。

---

## 安全與強化

### SessionID Sanitization

sessionID 直接用於檔案路徑 (`heartbeat-state/{sessionID}.json`)，存在 path traversal 風險。

```javascript
function sanitizeSessionID(raw) {
  if (typeof raw !== 'string') return 'unknown'
  // 只保留安全字元，移除 path separators 和特殊字元
  return raw.replace(/[^a-zA-Z0-9_\-]/g, '_')
}
```

所有檔案操作使用 `state.sessionIDSafe` 而非原始 sessionID。

### Session 數量上限 (LRU Eviction)

`states` Map 若無上限，session 持續累積會造成記憶體洩漏。

```javascript
const MAX_SESSIONS = 50

function createOrGetSession(sessionID) {
  if (states.size >= MAX_SESSIONS) {
    // Evict least recently used session
    const [oldestID] = [...states.entries()]
      .sort(([, a], [, b]) => (a.lastActivity || 0) - (b.lastActivity || 0))[0]
    cleanupSession(oldestID)
    states.delete(oldestID)
    log(`[WARN] session evicted: ${oldestID} (max ${MAX_SESSIONS})`)
  }
  // ... create new state
}
```

### Plugin Lifecycle: onStart / onStop

```javascript
module.exports = {
  onStart: async (opencode, client) => {
    // 0. Install uncaught exception handler
    process.on('uncaughtException', handlePluginCrash)
    process.on('unhandledRejection', handlePluginCrash)
    
    // 1. Load config from opencode.json
    // 2. validateConfig(config) → log warnings
    // 3. createPersistenceDir()
    // 4. Register event handlers (keep references for cleanup)
    // 5. Clean stale persistence files (>24h)
    // 6. clearAllTimers() (safety)
    // 7. log startup
  },
  
  onStop: async () => {
    // 0. Remove crash handlers
    process.off('uncaughtException', handlePluginCrash)
    process.off('unhandledRejection', handlePluginCrash)
    
    // 1. Unregister all event handlers (.off())
    // 2. clearAllTimers()
    // 3. Persist in-memory state to disk
    // 4. log shutdown
  }
}

// 全域 crash handler：確保 plugin crash 時留下資訊 + 不影響 OpenCode
function handlePluginCrash(err) {
  try {
    err('[FATAL] smart-heartbeat-local crashed:', err.message)
    err('[FATAL] stack:', err.stack)
    clearAllTimers()
    // 注意：不要在這裡做檔案 I/O（可能也是 crash 原因）
  } catch (_) {
    // 什麼都不做，靜默消失
  }
}

// Helper: 集中管理所有 timer，方便 cleanup
const activeTimers = new Set()

function setSafeTimeout(fn, delay) {
  const id = setTimeout(() => {
    activeTimers.delete(id)
    fn()
  }, delay)
  activeTimers.add(id)
  return id
}

function clearAllTimers() {
  for (const id of activeTimers) clearTimeout(id)
  activeTimers.clear()
}
```

### Startup/Shutdown Fallback Paths (FIX)

onStart 的 7 個步驟各有明確定義的失敗降級路徑：

| Step | 操作                     | 失敗情境                       | 降級行為                                                     |
| ---- | ------------------------ | ------------------------------ | ------------------------------------------------------------ |
| 0    | Install crash handlers   | `process.on` 不支援 (old Node) | 靜默跳過，不阻擋啟動                                         |
| 1    | Load config              | 檔案不存在 / JSON parse error  | 使用全預設值，log `[WARN] config load failed, using defaults` |
| 2    | Validate config          | Type/range 驗證失敗            | log 所有錯誤，使用全預設值，不 crash                         |
| 3    | createPersistenceDir     | 權限錯誤 / 磁碟滿              | 停用 persistence（不寫檔、不清理），log `[ERR] persistence disabled`，其他功能正常 |
| 4    | Register event handlers  | handler 註冊 throw             | 個別 handler 失敗不影響其他 handler 註冊，log `[ERR] handler registration failed: {type}` |
| 5    | Clean stale files (>24h) | 檔案鎖定 / EACCES              | 跳過該檔案，log `[WARN] stale cleanup skipped: {file}'`，不阻擋 |
| 6    | clearAllTimers()         | 無（空 Set）                   | 安全無操作                                                   |

**原則：任何 startup 步驟失敗都不阻止 plugin 啟動。** 功能以可用資源的最大化降級執行。

onStop 的 4 個步驟同理，且因為 shutdown 不可中斷，每個步驟有 timeout 保護：

| Step | Timeout | 超時行為                                                   |
| ---- | ------- | ---------------------------------------------------------- |
| 0    | 1s      | 強制移除 crash handler（try/catch）                        |
| 1    | 2s      | 跳過未完成的 unregister，繼續下一步                        |
| 2    | 500ms   | clearAllTimers 本身 O(1)                                   |
| 3    | 3s      | 放棄 persistence write，log `[ERR] onStop persist timeout` |

```javascript
// onStop 實作需包在 Promise.race 中防止 hang
async function safeOnStop(steps) {
  for (const [name, fn, timeoutMs] of steps) {
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timeout`)), timeoutMs))
      ])
    } catch (e) {
      err(`[WARN] onStop step ${name} failed: ${e.message}`)
      // 繼續下一步，不中斷 shutdown
    }
  }
}
```

### Config Validation

Plugin load 時驗證設定：

```javascript
function validateConfig(config) {
  const errors = []
  
  // Type validation (防止字串/NaN/undefined 滲入)
  const numFields = ['countdownSeconds', 'maxRecoveryAttempts', 'deathSpiralThreshold',
    'maxToolErrors', 'promptSpeedTps', 'effectiveMaxContext', 'maxStuckCycles',
    'maxRepeatedTool', 'maxIdleSeconds', 'recoveryVerificationMaxMs', 'deathSpiralWindowMs']
  
  for (const field of numFields) {
    const val = config[field]
    if (val !== undefined && (typeof val !== 'number' || isNaN(val) || val < 0)) {
      errors.push(`${field}: must be positive number, got ${typeof val} (${val})`)
    }
  }
  
  // Range validation
  if (config.countdownSeconds < 5) errors.push('countdownSeconds too low (<5)')
  if (config.maxRecoveryAttempts < 1) errors.push('maxRecoveryAttempts must be >= 1')
  if (config.deathSpiralThreshold < 1) errors.push('deathSpiralThreshold must be >= 1')
  if (config.maxToolErrors < 1) errors.push('maxToolErrors must be >= 1')
  if (config.persistence?.maxFiles < 1) errors.push('persistence.maxFiles must be >= 1')
  if (!['debug', 'warn', 'err'].includes(config.logLevel)) errors.push('invalid logLevel')
  
  return errors
}
```

驗證失敗時：log 所有錯誤，使用全預設值，不 crash plugin。**特別注意字串型態滲入（如 `"thirty"`），type check 確保全部為 number。**

### 全域 Heartbeat 衝突

若 `.opencode/plugins/smart-heartbeat-local.js` 和 `~/.config/opencode/plugins/smart-heartbeat.js` 同時啟用，兩個 plugin 會競爭注入續行。

**解決方案：** Local plugin 啟動時檢查 global plugin 的標記（如 `global.__smartHeartbeatLoaded`）。若已存在，local plugin 停用自身的 stuck/no-progress 偵測，只負責 model-specific 功能（recovery state machine、prompt processing guard、in-flight tool tracking）。

### macOS 睡眠喚醒處理 (FIX)

macOS 26 的 sleep/wake cycle 會讓 `setTimeout` 全部延遲到喚醒後瞬間同時過期，造成 timer callback 暴雨。Plugin 需在 timer callback 中加入喚醒偵測：

```javascript
// 所有 timer callback 的第一道 guard：檢查是否經歷睡眠週期
function isWakeAfterSleep(lastScheduledTime) {
  const elapsed = Date.now() - lastScheduledTime
  // 若實際經過時間比預期延遲長 10 倍以上，視為 sleep/wake
  return elapsed > 30000 // >30s gap = 極可能睡眠喚醒
}

// setSafeTimeout 改為記錄排程時間
function setSafeTimeout(fn, delay) {
  const scheduledAt = Date.now()
  const id = setTimeout(() => {
    activeTimers.delete(id)
    if (isWakeAfterSleep(scheduledAt + delay)) {
      warn(`[TIMER] wake after sleep detected (${Date.now() - scheduledAt - delay}ms overdue)`)
      return // 跳過 callback，避免喚醒後瞬間大量注入
    }
    fn()
  }, delay)
  activeTimers.add(id)
  return id
}
```

此外，`onStart` 時檢查 timer Set 是否不為空（表示上次 shutdown 未清乾淨），若有殘留 timer 則強制清理：

```javascript
// onStart 開頭
if (activeTimers.size > 0) {
  warn(`[STARTUP] ${activeTimers.size} orphaned timers found, cleaning up`)
  clearAllTimers()
}
```

這樣處理三個場景：

1. **闔蓋睡眠 → 打開喚醒**：timer callback 跳過，防止批量續行注入
2. **電池耗盡強制關機 → 重啟**：orphaned timer 被 onStart 清理
3. **長時間 idle 觸發省電模式**：isWakeAfterSleep 以 30s 為 threshold，正常長時間 idle（如 120s auto-resume）不受影響

---

## 事件交錯規則 (Event Interleaving)

生產環境中事件不會乖乖排隊。以下規則定義衝突時的處理優先級。

### 規則 1: Recovery 進行中不收新 Truncation

```
若 recoveryState !== 'idle'（無論 injected/verified/failed）：
  → 收到的 truncation 事件僅記錄到 truncationEvents（用於死亡螺旋統計）
  → 不觸發新的 recovery cycle
  → 不重置 verification timer
```

### 規則 2: 使用者緊急介入系統 (Emergency Intervention)

使用者必須能隨時接手控制權，解決問題後再讓 LLM 繼續。

#### 2a. Intervention State Machine

```javascript
state = {
  // ===== 使用者介入狀態 (NEW) =====
  interventionState: 'none',        // 'none' | 'user_active' | 'user_done'
  userLastActiveTime: 0,            // 使用者最後發言時間
  userInterventionCount: 0,         // 此 session 使用者介入次數
  heartbeatCooldownUntil: 0,        // 冷卻期間不 inject heartbeat
  heartbeatDisabled: false,         // true = 完全停用 heartbeat（使用者要求）
  resumePending: false,             // true = 使用者已處理完，等待 resume
}
```

#### 2b. 使用者訊息處理流程

```
message.completed 且 info.role === 'user'：

  Step 1: 清除所有進行中的 timer
    → clearRecoveryVerification(state)
    → clearAllSessionTimers(sessionID)

  Step 2: 完全重置所有計數器（使用者已接手，從頭開始）
    → state.interventionState = 'user_active'
    → state.userLastActiveTime = Date.now()
    → state.userInterventionCount++
    
    // Recovery 狀態機：全部歸零
    → state.recoveryState = 'idle'
    → state.recoveryLevel = 0
    → state.recoveryAttempts = 0       // ★ 重點：恢復嘗試次數也歸零
    → state.deathSpiral = false
    → state.recoveryQuality = 'unknown'
    → state.truncationEvents = []      // ★ 清除死亡螺旋歷史
    
    // Tool 監控：使用者可能已解決問題
    → state.toolErrorCount = 0
    → state.toolErrorAnalysis = { level: 0, pattern: 'none', toolType: null }
    → state.webSearchSuggested = false
    → state.consecutiveFailures = 0
    → state.stuckCount = 0
    // 🟢 DESIGN DECISION: contextWarnings 不重置（與 Phase 4 plan 一致）
    //    context 壓力是物理限制，使用者訊息無法釋放 context
    //    若重置，死亡螺旋 Method 3 (contextPressure + truncation) 不再觸發
    
    // 冷卻期：停止 inject heartbeat，給使用者時間操作
    → state.heartbeatCooldownUntil = Date.now() + 60000  // 60s 冷卻

  Step 3: 檢查使用者是否想繼續
    // 若 user 訊息包含「繼續」，視為 resume 信號
    → if (event.text?.includes('繼續') || event.text?.includes('/heartbeat continue'))
      → state.interventionState = 'none'
      → state.heartbeatCooldownUntil = 0
      → log `[OK] [${sessionID}] user requested resume, heartbeat restored`
    
    // 若 user 訊息包含停用指令
    → if (event.text?.includes('/heartbeat disable'))
      → state.heartbeatDisabled = true
      → state.interventionState = 'none'
      → log `[OK] [${sessionID}] heartbeat disabled by user command`
    
    // 預設：使用者可能在操作，進入冷卻等待
    → log `[OK] [${sessionID}] user intervention #${state.userInterventionCount}, cooldown started`
```

#### 2c. 自動 Resume 偵測（無需使用者操作）

```
每當 plugin 檢查是否要 inject 時（heartbeat check loop）：

if (state.interventionState === 'user_active') {
  const idleTime = Date.now() - state.userLastActiveTime
  
  if (idleTime > 120000) {
    // 使用者已 2 分鐘沒說話 → 自動 resume
    state.interventionState = 'none'
    state.heartbeatCooldownUntil = 0
    log `[OK] [${sessionID}] auto-resume after ${idleTime}ms inactivity`
    
  } else if (Date.now() < state.heartbeatCooldownUntil) {
    // 仍在冷卻期，跳過 inject
    return
  }
}

if (state.heartbeatDisabled) {
  return  // 使用者完全停用，不做任何事
}
```

#### 2d. 使用者指令介面

| 使用者輸入                      | 行為                            |
| ------------------------------- | ------------------------------- |
| `繼續` 或 `/heartbeat continue` | 立即 resume heartbeat，清除冷卻 |
| `/heartbeat disable`            | 完全停用 heartbeat，不再 inject |
| `/heartbeat enable`             | 重新啟用 heartbeat              |
| `/heartbeat status`             | 輸出目前 plugin 狀態摘要        |

> ⚠️ **與 Phase 4 的整合：** 此處的 `handleUserCommand` 僅供設計參考。`04-ux-integration.md` Task 4.3 的 `handleUserMessage(state, text, sessionID)` 是 canonical 版本 — 將 counter reset、cooldown、指令解析合併為一個函數。**參數順序為 `(state, text, sessionID)`**，與此處的參考版本不同。實作時以 Phase 4 版本為準。

```javascript
// ⚠️ REFERENCE ONLY — canonical implementation at 04-ux-integration.md Task 4.3
// Signature: handleUserMessage(state, text, sessionID) — 注意參數順序！
// 此處 handleUserCommand 保留為設計參考，不應直接使用。
function handleUserCommand(text, state, sessionID) {
  const cmd = text.trim().toLowerCase()
  
  if (cmd.includes('/heartbeat disable')) {
    state.heartbeatDisabled = true
    state.interventionState = 'none'
    clearAllSessionTimers(sessionID)
    log(`[CMD] [${sessionID}] heartbeat disabled`)
    return 'heartbeat_disabled'
  }
  
  if (cmd.includes('/heartbeat enable')) {
    state.heartbeatDisabled = false
    state.interventionState = 'none'
    state.heartbeatCooldownUntil = 0
    log(`[CMD] [${sessionID}] heartbeat enabled`)
    return 'heartbeat_enabled'
  }
  
  if (cmd.includes('/heartbeat status')) {
    const summary = buildStatusSummary(state, sessionID)
    // showToast 需要 opencode 參照（實作時從 module 層級 opencodeRef 讀取）
    try {
      if (typeof opencode?.showToast === 'function') {   // opencode 需從 closure 取得
        opencode.showToast(summary, 'info')
      }
    } catch (_) { /* showToast 非必要功能 */ }
    log(`[STATUS] [${sessionID}]\n${summary}`)
    return 'status_dumped'
  }
  
  // 「繼續」視為 resume 信號（不分大小寫）
  if (cmd.includes('繼續') && state.interventionState !== 'none') {
    state.interventionState = 'none'
    state.heartbeatCooldownUntil = 0
    state.heartbeatDisabled = false   // 同時啟用
    log(`[CMD] [${sessionID}] user said 繼續, heartbeat resumed`)
    return 'heartbeat_enabled'
  }
  
  return null
}
```

#### 2e. 使用者介入後的續行

當使用者 resume 後（自動或手動），plugin 從**當前 todos** 讀取任務狀態：

```
使用者操作完成（todos 可能已變）
  ↓
resume signal (繼續 / auto-detect / /heartbeat enable)
  ↓
讀取當前 todos（不是 persistence 中的舊資料）
  ↓
buildContinuationPrompt(state, currentTodos, config)
  ↓
注入續行提示，從當前未完成任務開始
  ↓
LLM 繼續執行（不知道中間發生過什麼，只看當前的任務）
```

這樣使用者可以：

1. 修改/新增/刪除任務
2. 手動執行部分 task
3. 修正 model 的錯誤
4. 然後讓 LLM 從正確的起點繼續

#### 2f. 營運可觀測性 (FIX — status UX)

目前 `/heartbeat status` 只寫 log，使用者需手動翻找。改為多通道輸出：

**通道優先級：**

1. `showToast(summary, 'info')` — UI 通知（若 OpenCode 支援）
2. `log('[STATUS] ...')` — 寫入 log file 作為紀錄
3. **被動偵測提示** — 當 plugin 偵測到異常（death spiral、recovery stopped、tool error 連發），自動觸發 notify：

```javascript
function autoNotify(state, sessionID, opencode) {
  // 自動發送通知的觸發條件
  const triggers = []
  if (state.deathSpiral)         triggers.push('死亡螺旋偵測，復原已停止')
  if (state.recoveryState === 'stopped') triggers.push('復原已達上限，等待使用者介入')
  if (state.toolErrorCount >= 8) triggers.push(`tool 錯誤 ${state.toolErrorCount} 次`)
  if (triggers.length === 0) return

  const msg = `[Heartbeat] ${triggers.join('; ')}`
  try {
    if (typeof opencode?.showToast === 'function') opencode.showToast(msg, 'warn')
  } catch (_) { /* fallback silent */ }
  warn(`[NOTIFY] [${sessionID}] ${msg}`)
}
```

**Log 格式統一：** 所有 log 前綴相同格式，便於 grep 過濾：

| 前綴           | 用途                     | 來源 Module          | grep 關鍵字             |
| -------------- | ------------------------ | -------------------- | ----------------------- |
| `[OK]`         | 正常流程                 | 所有 module          | `grep '\[OK\]'`         |
| `[WARN]`       | 異常但可恢復             | 所有 module          | `grep '\[WARN\]'`       |
| `[ERR]`        | 嚴重異常                 | 所有 module          | `grep '\[ERR\]'`        |
| `[RECOV]`      | Recovery 狀態機          | recovery.js          | `grep '\[RECOV\]'`      |
| `[PERSIST]`    | 進度持久化操作           | state.js             | `grep '\[PERSIST\]'`    |
| `[SHUTDOWN]`   | 關機流程步驟             | index.js             | `grep '\[SHUTDOWN\]'`   |
| `[GUARD]`      | Processing guard timeout | index.js             | `grep '\[GUARD\]'`      |
| `[FATAL]`      | Plugin crash handler     | index.js             | `grep '\[FATAL\]'`      |
| `[STARTUP]`    | 啟動階段                 | index.js             | `grep '\[STARTUP\]'`    |
| `[TIMER]`      | 計時器 / 睡眠喚醒 guard  | utils.js             | `grep '\[TIMER\]'`      |
| `[INJECT]`     | 續行注入操作             | injector.js          | `grep '\[INJECT\]'`     |
| `[TRUNC]`      | Truncation 偵測          | monitor.js / index.js | `grep '\[TRUNC\]'`      |
| `[CMD]`        | 使用者指令               | index.js             | `grep '\[CMD\]'`        |
| `[STATUS]`     | 狀態查詢                 | index.js             | `grep '\[STATUS\]'`     |
| `[NOTIFY]`     | 自動通知                 | recovery.js          | `grep '\[NOTIFY\]'`     |
| `[API-VERIFY]` | API 驗證                 | verify-api.js        | `grep '\[API-VERIFY\]'` |
| `[CONFIG]`     | 設定載入 / 驗證          | config.js            | `grep '\[CONFIG\]'`     |

> **規範：** 所有 log 前綴使用 `[PREFIX]` 格式，長度不超過 12 個字元。不在此表中的前綴不應出現在 production code 中。`[TOOL_ERR]` 已棄用，改用 `[WARN]` + 描述。新增前綴需同步更新此表格。

### 規則 3: Normal Continuation 與 Recovery 衝突

```
當 stuck/無進度/tool error 觸發 normal continuation 時：
  → 若同時有 truncation pending，recovery 優先
  → 若 recovery 正在進行中（injected），跳過 normal continuation
  → 若 recovery 已停止（stopped），使用 normal continuation（不觸發 recovery）

優先級：recovery > tool error > stuck > normal idle
```

### 規則 4: Verification Timer 安全 Guard

```
所有 setTimeout callback 的第一行必須檢查：
  1. session 仍然存在 (states.get(sessionID) !== undefined)
  2. recoveryState 仍然是預期的值 (callback 假設是 'injected')

若任一條件不符 → 靜默 return，不執行任何 state mutation
```

### 規則 5: 同一 Event Loop Tick 的多重事件

```
JavaScript 單執行緒，同一 tick 內的事件順序由 OpenCode 決定。
Plugin 不依賴特定 event 順序。所有的 state mutation 都是單一 tick 內
同步完成，無 race condition 風險。
```

---

## 測試策略

### 測試框架

| 工具                                  | 用途                    |
| ------------------------------------- | ----------------------- |
| Node.js native assert 或 Vitest       | Unit test runner        |
| `jest.useFakeTimers()` 或自製 mock    | Timer/verification 測試 |
| 記憶體中 mock-fs (Map<string,string>) | 檔案 I/O 測試           |
| EventEmitter mock                     | OpenCode event 模擬     |

### Mock Infrastructure

```javascript
// === Mock OpenCode Event System ===
class MockEvents {
  constructor() { this.handlers = {} }
  on(type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn)
    return { off: () => this.handlers[type] = this.handlers[type].filter(h => h !== fn) }
  }
  emit(type, data) {
    (this.handlers[type] || []).forEach(fn => fn(data))
  }
}

// === Mock setTimeout (fake timers) ===
let fakeTime = 0
const fakeTimers = []
function mockSetTimeout(fn, delay) {
  const id = setTimeout(fn, delay) // or custom implementation
  fakeTimers.push({ id, fireAt: fakeTime + delay, fn })
  return id
}
function advanceTime(ms) {
  fakeTime += ms
  const ready = fakeTimers.filter(t => t.fireAt <= fakeTime)
  // fire in order
  ready.sort((a,b) => a.fireAt - b.fireAt).forEach(t => t.fn())
}
```

### 測試案例總表

**Priority 0 (pure function — 每次 commit 執行):**

| 函數                                 | 案例數 | 測試重點                                                     |
| ------------------------------------ | ------ | ------------------------------------------------------------ |
| `shouldAttemptRecovery()`            | 6      | 6 個 return false 分支 + 1 個 true                           |
| `detectDeathSpiral()`                | 5      | 空/1次/3次 window 內外/連續失敗/context壓力                  |
| `getRecoveryPrompt()`                | 6      | Level 0/1/2/3 + in_progress 優先 + 空 todos                  |
| `estimateProcessTime()`              | 4      | 正常/極小/speed=0/超大                                       |
| `estimateContextTokens()`            | 5      | 正常/exchangeCount 路徑/空 history/cap/超大 (FIX: 加 exchangeCount 測試) |
| `assessRecoveryQuality()` (純函數版) | 4      | 重複 tool/error/正常/undefined                               |
| `buildContinuationPrompt()`          | 4      | 正常/tool error/stuck/context 壓力                           |
| `checkStuckState()`                  | 2      | 卡住/正常                                                    |
| `sanitizeSessionID()`                | 3      | 正常/特殊字元/非字串                                         |
| `validateConfig()`                   | 4      | 合法/無效/缺失/邊界                                          |
| `selectPromptTemplate()` (NEW)       | 5      | recovery/toolError/context/stuck/normal + unknown type fallback + style missing |
| `buildInjectPrompt()` (NEW)          | 3      | 正常 routing/錯誤 routing/edge case                          |
| `isWakeAfterSleep()` (NEW)           | 2      | 正常間隔/>30s 喚醒                                           |
| **Subtotal**                         | **44** |                                                              |

**Priority 1 (state machine — 每次 feature merge 執行):**

| 測試場景                                 | 案例數 |
| ---------------------------------------- | ------ |
| idle → injected                          | 1      |
| injected → verified (tool.started)       | 1      |
| injected → failed (timer expiry)         | 1      |
| failed → injected (escalate + retry)     | 1      |
| failed → stopped (max attempts)          | 1      |
| tool.started sets recoveryQuality        | 2      |
| User message resets state machine        | 2      |
| Stage1 timer (slow, not fail)            | 1      |
| Stage2 timer (failure)                   | 1      |
| tool.started clears both timers          | 1      |
| Timer after session/reset guard          | 2      |
| Startup fallback guard (FIX)             | 2      |
| User command showToast (FIX)             | 1      |
| autoNotify triggers (FIX)                | 2      |
| Orphaned timer on start (FIX)            | 1      |
| isWakeAfterSleep in timer callback (FIX) | 1      |
| **Subtotal**                             | **23** |

**Priority 2 (integration — 每次 release 執行):**

| 測試場景                                  | 案例數 |
| ----------------------------------------- | ------ |
| Plugin onStart registers handlers         | 1      |
| Plugin onStop clears all timers           | 1      |
| Persistence write → read → verify         | 1      |
| Event interleaving: recovery + truncation | 1      |
| Event interleaving: recovery + user msg   | 1      |
| API verify plugin loads (FIX)             | 1      |
| API verify plugin output (FIX)            | 1      |
| **Subtotal**                              | **7**  |

**總計：104 個測試案例**（按 phase 拆分：21+24+40+10+9），約 840-950 行測試 code。Phase 1 實作 ~875 行，測試 ~910 行，測試/實作比 ~1.04:1。

> 按 P 級拆分：P0 (pure function) 44 + P1 (state machine) 23 + P2 (integration) 7 = 74，是舊版分類。實際實作以 Phase-based 拆分為準（詳見 `index.md`）：21 (Phase 1) + 24 (Phase 2) + 40 (Phase 3) + 10 (Phase 4) + 9 (Phase 5) = **104 個測試案例**。

---

## 實作階段

### Phase 1: 建立中小型 Local LLM 專用 Plugin（本次）

| Task         | 內容                                                         | 關鍵程式碼估計 |
| ------------ | ------------------------------------------------------------ | -------------- |
| 1            | Plugin 骨架 + config schema + logging + init guards + **startup/shutdown fallback paths (FIX)** | ~90 行         |
| 2            | Session state 擴充 + 22 error handling 點 per-layer try/catch | ~60 行         |
| 3            | Prompt processing guard + adaptive timeout (context 大小估算 + **exchangeCount 獨立計數 (FIX)**) | ~50 行         |
| 4            | In-flight tool 追蹤 (started/completed mapping + tool timeout + task 特殊處理) | ~50 行         |
| 5            | Tool 監管 (completed/error/repeated + history + context 壓力) | ~60 行         |
| 6            | Context 截斷復原 (雙重持久化 + 3 種偵測 + grace window)      | ~50 行         |
| 7            | **Recovery 反饋迴圈狀態機 (NEW)** — 漸進提示升級 + 雙階段驗證 timer + 失敗重試 | ~60 行         |
| 8            | **死亡螺旋偵測 + 復原品質信號 (NEW)** — frequency analysis + quality check | ~40 行         |
| 9            | 卡住偵測強化 (todo + tool + idle 三信號 + 分級反應)          | ~40 行         |
| 10           | **Tool 錯誤分級與智能應對 (NEW)** — error pattern analyzer + 4 級 escalation + tool 類型感知 + web search 建議 + 錯誤螺旋增強 | ~80 行         |
| 11           | **Model Scale 系統 (NEW)** — 2 級 scale (small/medium) + auto-detect + name matching + config 合併邏輯 + 2 種 promptStyle 模板 | ~70 行         |
| 12           | 續行注入器 (5 種情境 prompt × 2 種 promptStyle + 4 級 recovery prompt + 4 級 tool error + **Injector Routing Matrix (FIX)**) | ~80 行         |
| 13           | 安全強化 (sessionID sanitization + LRU eviction + config validation + plugin lifecycle onStart/onStop) | ~50 行         |
| 14           | 事件交錯處理 (interleaving rules: recovery guard + normal priority + **macOS sleep/wake guard (FIX)**) | ~40 行         |
| 15           | **使用者緊急介入系統 (NEW)** — state machine + cooldown + resume + full state reset + **showToast status UX + autoNotify (FIX)** | ~70 行         |
| 16           | **API 驗證 plugin (FIX)** — 獨立於 main plugin, ~50 行, 開工前執行 | ~50 行         |
| 17           | 更新 opencode.json 註冊 plugin                               | ~5 行          |
| 18           | **Priority 0 純函數測試 (44 cases) (FIX)** — 含 routing matrix + isWakeAfterSleep | ~520 行測試    |
| 19           | **Priority 1 狀態機 + timer + fallback 測試 (23 cases) (FIX)** | ~250 行測試    |
| 20           | **Priority 2 整合測試 (7 cases) (FIX)**                      | ~140 行測試    |
| 21           | 最終語法驗證 + 完整性檢查                                    | -              |
| **實作總計** |                                                              | **~875 行**    |
| **測試總計** |                                                              | **~910 行**    |

### Phase 2: 進階功能（後續）

- 復原後自動重新讀取 AGENTS.md / CLAUDE.md / 專案指引檔案
- 品質信號依據調整 inject 策略（Phase 1 僅記錄）
- 卡住模式自動分類（區分 tool loop / error loop / idle / stuck thinking）
- 多 session 共用 persistence（跨 session 任務恢復）
- **根據復原品質統計調整死亡螺旋 threshold** (adaptive threshold)

---

## 續行提示模板（中小型 Local LLM 專用）

小型模型無法消化複雜指令，所以所有提示都**極簡**。中型模型使用 `short` 風格可稍長。

### 一般續行

```
[續行] 還有 N 項未完成。

下一項：任務 A
直接執行，完成後用 todowrite。不要問。
```

### Tool 錯誤（分 4 級，依錯誤次數自動升級 — 詳見關鍵功能 9）

**Level 1 (1 次 — 重試)：**

```
[續行] tool 失敗。重試任務「{task}」，注意指令語法。直接執行。
```

**Level 2 (2-3 次 — 換方法)：**

```
[續行] tool 失敗 {N} 次。換個方法做「{task}」。不要重複同一 tool。直接執行。
```

**Level 3 (4-6 次 — 完全換方向 + tool 類型感知)：**

```
[續行] tool 一直失敗。用完全不同方法做「{task}」。
如果原本用 bash，改用 write；如果原本用 edit，改用 read+write。
不要再用 {lastTool}。直接執行。
```

**Level 4 (7+ 次 — 搜尋網路)：**

```
[續行] tool 持續失敗 {N} 次。你目前的方法不對。
先用 websearch 搜尋解決方案，理解正確做法後再執行。
不要猜，不要重複同一個 tool。搜尋後再繼續。
```

### 卡住

```
[續行] 卡住（{reason}）。

換全新方法做任務 A。不要重複。直接執行。
```

### Context 壓力

```
[續行] context 壓力大。任務餘 {N}。

任務 A。直接完成，避免大型輸出。
```

### Context 截斷復原（含漸進層級）

**Level 0 (首次，最低成本)：**

```
繼續
```

**Level 1 (第二次，稍微明確)：**

```
繼續任務
```

**Level 2 (第三次，指定任務)：**

```
繼續: 任務 A
```

**Level 3 (最後手段，完整注入)：**

```
[系統復原] 上下文已重置。

未完成任務：
1. 任務 A
2. 任務 B

從任務 A 繼續。先讀取相關檔案，再繼續完成。不要從頭開始。
```

---

## 最終 Review — 生產就緒檢查

### ✅ 已涵蓋的層面（33 項）

| #    | 面向                                | 設計內容                                                     |
| ---- | ----------------------------------- | ------------------------------------------------------------ |
| 1    | Local LLM 速度                      | Adaptive timeout based on context size                       |
| 2    | Prompt processing 延遲              | Processing guard 避免重複注入                                |
| 3    | Tool 錯誤復原                       | Error count + threshold stop                                 |
| 4    | Tool 重複偵測                       | Repeated tool loop detection                                 |
| 5    | In-flight tool 監控                 | Task/bash tool timeout                                       |
| 6    | Context 截斷復原                    | File persistence + 3 detection methods                       |
| 7    | **復原驗證 (NEW)**                  | 雙階段 timer 確認 model 真的繼續執行                         |
| 8    | **漸進提示升級 (NEW)**              | Level 0-3: 「繼續」→「繼續任務」→「繼續:任務A」→ 完整注入    |
| 9    | **死亡螺旋偵測 (NEW)**              | 頻率分析 + context 壓力 + 連續失敗，5min/3次 threshold       |
| 10   | **復原品質信號 (NEW)**              | tool 重複 + error rate 檢查，Phase 1 僅記錄                  |
| 11   | Context 壓力監控                    | Large output tracking + pre-recovery check                   |
| 12   | 續行提示極簡                        | Gemma-4 4B 專用 < 50 字 prompt                               |
| 13   | 卡住偵測強化                        | Todo + tool + idle triple signal                             |
| 14   | 進度持久化                          | Debounced atomic writes                                      |
| 15   | 停滯檔案清理                        | >24h cleanup + max 100 files                                 |
| 16   | Agent routing                       | Detect + target same agent                                   |
| 17   | Log 管理                            | Project-local + rotation                                     |
| 18   | Error handling                      | 37 個保護點, 9 layers (含 sleep guard + startup fallback + injector routing fallback) (FIX) |
| 19   | 多 session 隔離                     | Map<sessionID>                                               |
| 20   | 配置可覆蓋                          | 所有 threshold 皆可設定                                      |
| 21   | 降級策略                            | 每層獨立 try/catch, 不影響 OpenCode                          |
| 22   | **事件交錯處理**                    | 5 條 interleaving rules, recovery guard, user reset, priority (NEW) |
| 23   | **安全強化**                        | SessionID sanitization, LRU eviction, config validation (NEW) |
| 24   | **Plugin lifecycle**                | onStart/onStop handler + timer cleanup + state persist on stop (NEW) |
| 25   | **client.session.prompt 假設**      | 文件化 3 種模式及對應方案，Phase 1 第一步驗證 (NEW)          |
| 26   | **truncation 偵測 grace window**    | todo 清空後等 5-10s 確認非刻意行為 (NEW)                     |
| 27   | **可測試性**                        | 104 測試案例 (21+24+40+10+9), Priority 0/1/2 分級, mock infrastructure (NEW)  |
| 28   | **Tool 錯誤分級應對 (NEW)**         | 4 級 escalation, tool 類型感知, web search 建議, 錯誤螺旋增強 |
| 29   | **Tool 錯誤死亡螺旋 (NEW)**         | 大量 tool 錯誤 + truncation = 觸發死亡螺旋保護               |
| 30   | **Model Scale 系統 (NEW)**          | 2 級 scale (small/medium), 2 種 promptStyle, config 合併     |
| 31   | **跨模型適應 (NEW)**                | auto-detect 自動對應 small/medium scale，調整全部 22 參數 + 提示風格 |
| 32   | **使用者緊急介入 (NEW)**            | full state reset, cooldown, resume auto-detect, /heartbeat commands |
| 33   | **介入後續行 (NEW)**                | 從當前 todos 重新開始，不受舊 counter 影響                   |
| 34   | **Injector Routing Matrix (FIX)**   | promptType × promptStyle × level 路由演算法, 84 種組合       |
| 35   | **API 驗證 Plugin (FIX)**           | 最小 ~50 行驗證 plugin, 確認 4 個未知 API 行為               |
| 36   | **Startup/Shutdown Fallback (FIX)** | 7 個 startup 步驟各有明確定義失敗降級路徑                    |
| 37   | **macOS 睡眠喚醒 Guard (FIX)**      | timer callback 喚醒偵測, orphaned timer 清理, 30s threshold  |

### ⚠️ 以下 5 項超出範圍（應在 Phase 2 或獨立處理）

| #    | 項目                 | 原因                                    | 建議     |
| ---- | -------------------- | --------------------------------------- | -------- |
| 1    | Token 用量精確計算   | 需要 tokenizer 或 API 回傳的 usage 資訊 | Phase 2  |
| 2    | 自動重讀 AGENTS.md   | 復原後重新載入專案指引                  | Phase 2  |
| 3    | 多實例防衝突         | 同 project 開兩個 OpenCode 的檔案衝突   | 低優先級 |
| 4    | 品質信號自動調整策略 | 根據 recovery quality 調整 inject 行為  | Phase 2  |
| 5    | 模型自動切換         | cloud model 卡住自動切 local, 反之亦然  | 獨立功能 |

### 🔍 專業工程建議

#### 建議 1: 實作順序應為 Bottom-Up

先建立底層保護機制，再蓋上層邏輯：

```
Step 0:  API verify plugin（~50行, 獨立, 確認4個未知API行為）★ FIX
Step 1:  骨架 + config + startup fallback paths + logging + error guards（地基）
Step 2:  Event router + state management（管線）
Step 3:  In-flight tool tracking + prompt guard（核心監控）
Step 4:  Tool monitoring + context pressure（分析層）
Step 5:  Truncation detection + persistence（持久層）
Step 6:  Recovery state machine（反饋迴圈）★ NEW
Step 7:  Death spiral + quality（保護機制）★ NEW
Step 8:  Event interleaving rules + macOS sleep guard + safety guards ★ FIX
Step 9:  Stuck detector（決策層）
Step 10: Continuation injector + routing matrix（輸出層）★ FIX
Step 11: Security hardening (sanitize + LRU + lifecycle) ★ NEW
Step 12: opencode.json + 營運觀測（整合）★ FIX
Step 13: Priority 0 pure function tests ★ NEW
Step 14: Priority 1 state machine + timer + fallback tests ★ FIX
Step 15: Priority 2 integration tests ★ NEW
```

#### 建議 2: 每個 function 應可獨立測試

Plugin 無法 unit test（需要 OpenCode runtime），但 function 可以：

```javascript
// ===== 可測試：純函數，無 side effect =====
function buildContinuationPrompt(state, todos, config) { ... }
function checkStuckState(state, todos) { ... }
function estimateContextTokens(state, config) { ... }         // 推估演算法
function estimateProcessTime(contextSize, speed) { ... }
function getRecoveryPrompt(level, todos, state) { ... }       // NEW
function detectDeathSpiral(state, now, config) { ... }        // NEW
function shouldAttemptRecovery(state, config) { ... }         // NEW
function assessRecoveryQuality(state, toolEvent) { ... }      // NEW: 純函數版
function sanitizeSessionID(raw) { ... }                       // NEW
function validateConfig(config) { ... }                       // NEW
function detectTruncation(todosBefore, todosAfter) { ... }    // NEW
function detectModelProfile(opencode) { ... }                // NEW: auto-detect
function matchModelToProfile(modelName) { ... }              // NEW: name matching
function getPromptStyle(config) { ... }                      // NEW: prompt style selector
function handleUserCommand(text, state) { ... }             // NEW: parse user commands
function buildStatusSummary(state) { ... }                  // NEW: status report
function shouldSkipInjection(state) { ... }                 // NEW: check cooldown + disabled

// ===== 不可測試：有 side effect =====
function injectContinuation(sessionID) { ... }
function persistState(sessionID, state) { ... }
function startRecoveryVerification(sessionID) { ... }         // NEW
function handleRecoverySuccess(sessionID) { ... }             // NEW
function executeRecovery(sessionID) { ... }                   // NEW
function resetRecoveryStateMachine(state) { ... }             // NEW
```

#### 建議 3: Log 策略

```
// 三級 log
log()    → 正常流程（可關閉）
warn()   → 異常但可恢復（預設開啟）
err()    → 嚴重異常, 影響功能（必開, 加 toast）

// 格式
[TYPE] [sessionID] message
e.g., [WARN] [ses_xxx] tool.error x3: bash

// 級別控制
DEBUG=true  → 顯示所有 log
DEBUG=false → 只顯示 warn + err

// Recovery-specific log (NEW)
[RECOV] [sessionID] recovery injected (level 0, attempt 1)
[RECOV] [sessionID] recovery verified (attempt 1, quality: good)
[RECOV] [sessionID] recovery failed (attempt 1, no tool call in 30s)
[RECOV] [sessionID] death spiral detected, recovery stopped
```

#### 建議 4: 檔案拆分策略（FIX — 開工前決定）

基於 Phase 1 實作預估 ~845 行，已超過單一檔案維護的合理上限。改為**開工前決定結構**，而非等超標才重構：

```
smart-heartbeat-local/
├── index.js          # Plugin entry + event router + lifecycle   (~100 行)
├── config.js          # Config schema + validation + model profiles (~120 行)
├── state.js           # State management + persistence + LRU     (~130 行)
├── monitor.js         # Tool monitoring + context pressure + stuck (~110 行)
├── recovery.js        # Recovery state machine + death spiral + timers (~140 行)
├── injector.js        # Prompt building + routing matrix + styles (~120 行)
└── utils.js           # sanitizeSessionID, estimateContextTokens, log (~80 行)
```

**為什麼現在拆分而不是等 650 行：**

1. 單一檔案 845 行時重構比直接拆分困難 — function 間已產生 implicit coupling
2. 各 module 有自然的邊界（event / state / decision / output），拆分不增加複雜度
3. 測試也可對應 module 拆分，不必 mock 整個 plugin
4. 每檔案 100-140 行，review 負擔低

**每個檔案的匯出介面需在開工前決定**（例如 recovery.js exports 哪些 function），避免實作過程中跨檔案 reference 混亂。

---

## 實作完成 Check List

- [ ] Plugin 骨架建立（config + log + init guards）
- [ ] Event router（8 event types）
- [ ] In-flight tool tracking
- [ ] Prompt processing guard + adaptive timeout
- [ ] Tool monitoring（completed/error/repeated/context）
- [ ] **Tool error pattern analyzer (NEW)**
- [ ] **Tool error escalation levels 1-4 (NEW)**
- [ ] **Tool-type aware error prompts (NEW)**
- [ ] **Web search suggestion at level 4 (NEW)**
- [ ] Context truncation detection（3 methods）
- [ ] Progress persistence（debounced atomic write）
- [ ] **Recovery state machine (NEW)**
- [ ] **Progressive prompt escalation (NEW)**
- [ ] **Two-stage recovery verification timer (NEW)**
- [ ] **Death spiral detection (NEW)**
- [ ] **Recovery quality signals (NEW)**
- [ ] Stuck detection（todo + tool + idle）
- [ ] Continuation injector（5 prompt types + 4 recovery levels）
- [ ] **Plugin lifecycle (onStart/onStop + timer cleanup) (NEW)**
- [ ] **Security hardening (sanitizeSessionID + LRU eviction) (NEW)**
- [ ] **Config validation on load (NEW)**
- [ ] **Event interleaving rules (recovery guard + user reset + priority) (NEW)**
- [ ] **Model auto-detect (model name matching) (NEW)**
- [ ] **2-level model scale (small/medium) + promptStyle templates (NEW)**
- [ ] **Grace window for truncation detection (NEW)**
- [ ] **uncaughtException / unhandledRejection handler (NEW)**
- [ ] **Config type validation (NEW)**
- [ ] **User emergency intervention: state machine + cooldown + resume + commands (NEW)**
- [ ] **/heartbeat enable / disable / status / continue commands (NEW)**
- [ ] **Injector routing matrix (7 promptTypes × 3 styles × 4 levels) (FIX)**
- [ ] **API verify plugin (~50 行, onStart 前先跑) (FIX)**
- [ ] **Startup/Shutdown fallback paths (7 steps × fail → degrade) (FIX)**
- [ ] **macOS sleep/wake guard (timer callback + orphaned cleanup) (FIX)**
- [ ] **Operational observability (showToast + autoNotify + log prefix) (FIX)**
- [ ] Error handling 37 guards
- [ ] opencode.json registration
- [ ] **Phase 1 單元測試: 21 cases (config 10 + utils 11)**
- [ ] **Phase 2 單元測試: 24 cases (state 12 + monitor 12，含 detectTruncation + loadFromPersistence)**
- [ ] **Phase 3 單元測試: 39 cases (recovery 26 + injector 13)**
- [ ] **Phase 4 整合測試: 10 cases (intervention 6 + integration 4)**
- [ ] **Phase 5 系統測試: 9 cases (S1-S9)**
- [ ] Node syntax validation
- [ ] Final review passed
