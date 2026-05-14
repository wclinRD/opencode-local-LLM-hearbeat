# opencode-local-LLM-hearbeat

Solve local LLM cannot continue process task — Smart Heartbeat Plugin for OpenCode.

專為 local LLM (Gemma 4 4B, Qwen3.5, LocoOperator 等) 設計的 Smart Heartbeat plugin。
解決 context 壓力、tool 錯誤循環、復原後再次忘記、以及死亡螺旋等生產問題。

## 目錄結構

```
opencode-local-LLM-hearbeat/
├── plugin/
│   ├── smart-heartbeat-local.js              # Global v3 plugin (reference)
│   └── smart-heartbeat-local/                # Local LLM plugin (主力)
│       ├── index.js                          # Entry + lifecycle + event router
│       ├── config.js                         # Config schema + validation + model profiles
│       ├── state.js                          # Session state + persistence + LRU
│       ├── monitor.js                        # Tool monitoring + context pressure + stuck detection
│       ├── recovery.js                       # Recovery state machine + death spiral
│       ├── injector.js                       # Prompt routing + templates + injection
│       ├── utils.js                          # Utilities: logger, timer, todo reader
│       ├── verify-api.js                     # API behavior verification script
│       └── test/                             # 9 test files, 104 test cases total
│           ├── mock.js                       # Shared test infrastructure
│           ├── phase1-config.test.js         # Config unit tests (10)
│           ├── phase1-utils.test.js          # Utils unit tests (11)
│           ├── phase2-state.test.js          # State unit tests (12)
│           ├── phase2-monitor.test.js        # Monitor unit tests (12)
│           ├── phase3-recovery.test.js       # Recovery unit tests (27)
│           ├── phase3-injector.test.js       # Injector unit tests (13)
│           ├── phase4-intervention.test.js   # Intervention integration tests (6)
│           ├── phase4-integration.test.js    # Integration tests (4)
│           └── system.test.js                # System-level E2E tests (9)
├── docs/
│   └── plans/
│       ├── index.md                          # Master plan overview
│       ├── 01-foundation.md                  # Phase 1: Foundation (config + utils)
│       ├── 02-state-monitoring.md            # Phase 2: State & Monitoring
│       ├── 03-recovery-response.md           # Phase 3: Recovery & Response
│       ├── 04-ux-integration.md              # Phase 4: UX & Integration
│       ├── 05-system-testing.md              # Phase 5: System Testing
│       ├── 2026-05-13-heartbeat-local-llm.md # Full design document
│       ├── DEPLOY.md                         # Deployment guide
│       ├── review-complete.md                # Code review findings
│       └── _archive/                         # Archived plans
└── README.md                                 # This file
```

## 需求

| 項目 | 需求 |
|------|------|
| OpenCode | >= 1.14.0 |
| Node.js | >= 18 (built-in `node:test` support) |

## 安裝步驟

### 1. 複製 Plugin 到你的專案

```bash
# 在你的 OpenCode 專案根目錄
cp -r plugin/smart-heartbeat-local /path/to/your/project/.opencode/plugins/
```

### 2. 註冊 Plugin

在專案的 `.opencode/opencode.json` 中加入：

```json
[".opencode/plugins/smart-heartbeat-local/index.js", {
  "allowAllAgents": true,
  "countdownSeconds": 30,
  "minIntervalMs": 90000,
  "maxStuckCycles": 8
}]
```

完整選項請參考 `docs/plans/DEPLOY.md`。

### 3. 執行測試驗證

```bash
# 語法驗證
for f in plugin/smart-heartbeat-local/*.js; do node -c "$f"; done

# 執行全部 104 個測試
node --test plugin/smart-heartbeat-local/test/
```

### 4. 在 OpenCode 中使用

啟動 OpenCode 後，Plugin 會自動載入。使用以下命令控制：

```
/heartbeat on      # 開啟自動續行 (預設)
/heartbeat off     # 關閉自動續行
/heartbeat status  # 查看目前狀態
```

## Plugin 功能

| 功能 | 說明 |
|------|------|
| 慢節奏續行 | 預設 30s countdown，給 local model 足夠時間 |
| Tool 錯誤容錯 | 4 級錯誤升級 (retry → change method → tool-type aware → web search) |
| 進度持久化 | Context 截斷後從磁碟恢復任務狀態 |
| Context 壓力監控 | 估算 tool output 大小，context 滿前預警 |
| 復原反饋迴圈 | 注入後驗證模型是否真的執行，失敗時逐級升級 |
| 死亡螺旋偵測 | 5 種方法偵測惡性循環，自動停止復原 |
| macOS 睡眠保護 | 喚醒後跳過過期 timer，避免大量注入 |
| 使用者緊急介入 | `/heartbeat` 命令控制 + 60s cooldown |

## 更多文件

- 完整設計文件: `docs/plans/2026-05-13-heartbeat-local-llm.md`
- 部署指南: `docs/plans/DEPLOY.md`
- Code Review: `docs/plans/review-complete.md`

---

## LLM 安裝指引 (給 LLM Agent 閱讀)

以下區塊設計給 codegen agent (Claude Code / Codex CLI / OpenCode / Gemini CLI) 直接讀取並執行。

### 這是什麼

`smart-heartbeat-local` 是一個 OpenCode plugin，專為 **local LLM** (Gemma 4 4B、Qwen3.5、Phi、Llama 等) 設計。

**要安裝的 agent 請注意：你的 cwd 就是目標專案根目錄。** 所有相對路徑都以目標專案根目錄為基準。

### 安裝流程

**Step 0: 檢查環境**

```json
{
  "check": "Node.js version",
  "command": "node --version",
  "expected": "v18.x or higher"
}
{
  "check": "OpenCode version",
  "command": "opencode --version",
  "expected": "1.14.0 or higher (check if command exists)"
}
{
  "check": "Target project",
  "command": "ls .opencode/opencode.json",
  "expected": "file exists (if not, this may not be an OpenCode project root)"
}
```

**Step 1: Clone 此 repo 到暫存目錄**

```bash
git clone https://github.com/wclinRD/opencode-local-LLM-hearbeat.git /tmp/opencode-hearbeat
```

**Step 2: 在目標專案中建立目錄**

```bash
# 從目標專案根目錄執行
mkdir -p .opencode/plugins/smart-heartbeat-local/test
```

**Step 3: 複製 plugin 檔案**

```bash
cp /tmp/opencode-hearbeat/plugin/smart-heartbeat-local/*.js .opencode/plugins/smart-heartbeat-local/
```

**Step 4: 複製測試檔案**

```bash
cp /tmp/opencode-hearbeat/plugin/smart-heartbeat-local/test/*.js .opencode/plugins/smart-heartbeat-local/test/
```

**Step 5: 語法驗證**

```bash
for f in .opencode/plugins/smart-heartbeat-local/*.js; do node -c "$f" 2>/dev/null && echo "OK: $f" || echo "FAIL: $f"; done
```

預期輸出：每行都是 `OK:` 前綴，無 `FAIL:`。

**Step 6: 註冊 Plugin**

在 `.opencode/opencode.json` 的 `plugins` 陣列中加入以下 entry：

```json
[".opencode/plugins/smart-heartbeat-local/index.js", {
  "allowAllAgents": true,
  "countdownSeconds": 30,
  "minIntervalMs": 90000,
  "maxStuckCycles": 8,
  "maxToolErrors": 8,
  "maxRepeatedTool": 10,
  "maxIdleSeconds": 120,
  "maxRecoveryAttempts": 3,
  "logLevel": "warn"
}]
```

⚠️ **專案路徑規則：永遠使用相對路徑 `.opencode/plugins/smart-heartbeat-local/`。** 不要安裝到 `~/.config/opencode/plugins/`。

**Step 7: 執行測試**

```bash
node --test .opencode/plugins/smart-heartbeat-local/test/
```

預期輸出應包含：
```
ℹ tests 104
ℹ pass 104
ℹ fail 0
```

若 `node --test` 回傳非零 exit code，檢查 Step 3-4 複製是否完整，不要直接修改 plugin 程式碼。

**Step 8: 在 OpenCode 中驗證**

啟動 OpenCode，執行 `/heartbeat status`。預期看到類似輸出：

```
Session: ses_xxx
Enabled: true
Intervention: none (0 times)
Recovery: idle (0 attempts)
Death spiral: false
Tool errors: 0 (level 0)
```

若 `/heartbeat status` 無回應，檢查 Step 6 的 opencode.json 格式是否正確。

### 關鍵規則

```
1. 目標專案的路徑 = 你的 cwd。所有相對路徑以此為基準。
2. 不要安裝到 ~/.config/opencode/plugins/ — 使用 .opencode/plugins/smart-heartbeat-local/
3. Step 5 (語法驗證) 必須全部通過，才能進行 Step 6 (註冊)
4. 如果測試失敗，先重新確認 Step 3-4 複製是否完整，不要直接改 plugin 程式碼
5. plugin 格式: module.exports = { onStart, onStop } — 不是 export default { id, server }
```

### 安裝後檢查清單

| 檢查項 | 驗證方式 | 成功條件 |
|--------|---------|---------|
| 檔案存在 | `ls .opencode/plugins/smart-heartbeat-local/*.js` | 8 個 .js 檔案 |
| 語法正確 | `node -c` 每個檔案 | 全部 OK |
| Plugin 載入 | `node -e "require('.opencode/plugins/smart-heartbeat-local/index.js')"` | 無錯誤 |
| 測試通過 | `node --test` | 104 pass, 0 fail |
| OpenCode 回應 | `/heartbeat status` | 顯示完整狀態 |

### 聯絡設計文件

- `docs/plans/2026-05-13-heartbeat-local-llm.md` — 完整設計原理
- `docs/plans/DEPLOY.md` — 完整部署選項 (含人類版+LLM版)
