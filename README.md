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

以下區塊設計給 codegen agent (Claude Code / Codex CLI / OpenCode / Gemini CLI) 直接讀取並執行。結構化為 json block 方便 parse。

```jsonc
// LLM_INSTALL_INSTRUCTIONS
{
  "plugin": "smart-heartbeat-local",
  "repo": "https://github.com/wclinRD/opencode-local-LLM-hearbeat",
  "targetPath": ".opencode/plugins/smart-heartbeat-local/",
  "files": [
    "index.js", "config.js", "state.js", "monitor.js",
    "recovery.js", "injector.js", "utils.js", "verify-api.js"
  ],
  "testFiles": [
    "mock.js", "phase1-config.test.js", "phase1-utils.test.js",
    "phase2-state.test.js", "phase2-monitor.test.js",
    "phase3-recovery.test.js", "phase3-injector.test.js",
    "phase4-intervention.test.js", "phase4-integration.test.js",
    "system.test.js"
  ],
  "installSteps": [
    {
      "step": 1,
      "action": "clone_repo",
      "command": "git clone https://github.com/wclinRD/opencode-local-LLM-hearbeat.git /tmp/opencode-hearbeat",
      "description": "Clone repo to temp directory"
    },
    {
      "step": 2,
      "action": "create_target_dir",
      "command": "mkdir -p /path/to/target/project/.opencode/plugins/smart-heartbeat-local/test",
      "description": "Ensure target directories exist"
    },
    {
      "step": 3,
      "action": "copy_plugin_files",
      "command": "cp /tmp/opencode-hearbeat/plugin/smart-heartbeat-local/*.js /path/to/target/project/.opencode/plugins/smart-heartbeat-local/",
      "description": "Copy all plugin .js files to target"
    },
    {
      "step": 4,
      "action": "copy_test_files",
      "command": "cp /tmp/opencode-hearbeat/plugin/smart-heartbeat-local/test/*.js /path/to/target/project/.opencode/plugins/smart-heartbeat-local/test/",
      "description": "Copy all test files to target"
    },
    {
      "step": 5,
      "action": "verify_syntax",
      "command": "for f in .opencode/plugins/smart-heartbeat-local/*.js; do node -c \"$f\" 2>/dev/null && echo \"OK: $f\" || echo \"FAIL: $f\"; done",
      "description": "Verify all plugin files have valid syntax"
    },
    {
      "step": 6,
      "action": "register_plugin",
      "description": "Add plugin entry to .opencode/opencode.json or ~/.config/opencode/opencode.json",
      "configTemplate": {
        "pluginPath": ".opencode/plugins/smart-heartbeat-local/index.js",
        "options": {
          "allowAllAgents": true,
          "countdownSeconds": 30,
          "minIntervalMs": 90000,
          "maxStuckCycles": 8,
          "maxToolErrors": 8,
          "maxRepeatedTool": 10,
          "maxIdleSeconds": 120,
          "maxRecoveryAttempts": 3,
          "logLevel": "warn"
        }
      }
    },
    {
      "step": 7,
      "action": "run_tests",
      "command": "node --test .opencode/plugins/smart-heartbeat-local/test/",
      "expectedOutput": "104 tests all pass (21+24+40+10+9)"
    },
    {
      "step": 8,
      "action": "verify_in_opencode",
      "description": "Launch OpenCode and run /heartbeat status to confirm plugin loaded"
    }
  ],
  "criticalRules": [
    "DO NOT install to ~/.config/opencode/plugins/ — use project-local path .opencode/plugins/smart-heartbeat-local/",
    "Run step 5 (syntax verify) BEFORE step 6 (register plugin)",
    "If tests fail, check step 3-4 file copy before debugging plugin code",
    "plugin format: module.exports = { onStart, onStop } — NOT export default { id, server }"
  ],
  "configReference": "docs/plans/DEPLOY.md has full config options and LLM-parseable install block"
}
```
