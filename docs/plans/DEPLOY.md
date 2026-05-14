# DEPLOY — Smart Heartbeat Local LLM Plugin

> 雙格式安裝指南：人類走左、LLM 走右。

---

## 1. 前置檢查

| 項目 | 需求 |
|------|------|
| OpenCode | >= 1.14.0 |
| Node.js | >= 18 (built-in `node:test` support) |
| 目錄 | `.opencode/plugins/smart-heartbeat-local/` (project-local) |
| 全域 plugin | `~/.config/opencode/plugins/smart-heartbeat.js` (v2 global, reference only) |

---

## 2. 安裝步驟（人類版）

### Step 1: API 驗證

```bash
# 在專案根目錄執行
node .opencode/plugins/smart-heartbeat-local/verify-api.js
```

確認輸出無 error。若 fail，回報 API 行為並等待修正。

### Step 2: Phase 1 — Foundation

```bash
# 建立目錄
mkdir -p .opencode/plugins/smart-heartbeat-local/

# 驗證語法
node -c .opencode/plugins/smart-heartbeat-local/config.js
node -c .opencode/plugins/smart-heartbeat-local/utils.js
```

### Step 3: Phase 2 — State + Monitor

```bash
node -c .opencode/plugins/smart-heartbeat-local/state.js
node -c .opencode/plugins/smart-heartbeat-local/monitor.js
```

### Step 4: Phase 3 — Recovery + Injector

```bash
node -c .opencode/plugins/smart-heartbeat-local/recovery.js
node -c .opencode/plugins/smart-heartbeat-local/injector.js
```

### Step 5: Phase 4 — Index (entry point)

```bash
node -c .opencode/plugins/smart-heartbeat-local/index.js
```

### Step 6: 加入 opencode.json

OpenCode Desktop 會自動從 `.opencode/plugins/` 載入 plugin，**無需修改 `opencode.json`**。

若想明確註冊，在專案 `opencode.json` 的 `plugin` 陣列中加入：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///absolute/path/to/<project>/.opencode/plugins/smart-heartbeat.js"
  ]
}
```

> ⚠️ `"plugins"` (複數) key 無效 — OpenCode 不支援，會導致 `ConfigInvalidError`。
> 必須使用 `"plugin"` (單數) + `file://` 絕對路徑。

### Step 7: 驗證安裝

```bash
# 檢查 wrapper 可載入
node -e "require('.opencode/plugins/smart-heartbeat.js')"

# 在 OpenCode 中測試
# 輸入 /heartbeat status 確認輸出正常
```

### Step 8: 執行測試

```bash
node --test .opencode/plugins/smart-heartbeat-local/test/
```

預期輸出：104 tests all pass（21+24+40+10+9）。

---

## 3. 安裝步驟（LLM 版）

以下區塊設計給 codegen agent 直接讀取並執行。結構化為 json block 方便 parse。

```jsonc
// LLM_INSTALL_INSTRUCTIONS
{
  "plugin": "smart-heartbeat-local",
  "targetPath": ".opencode/plugins/smart-heartbeat-local/",
  "globalRef": "~/.config/opencode/plugins/smart-heartbeat.js",
  "implementationOrder": [
    {
      "phase": 1,
      "name": "Foundation",
      "files": ["config.js", "utils.js", "verify-api.js"],
      "tests": ["mock.js", "phase1-config.test.js", "phase1-utils.test.js"],
      "gate": "node -c config.js && node -c utils.js"
    },
    {
      "phase": 2,
      "name": "State + Monitor",
      "files": ["state.js", "monitor.js"],
      "tests": ["phase2-state.test.js", "phase2-monitor.test.js"],
      "gate": "plugin loads, events recorded",
      "dependsOn": "phase1"
    },
    {
      "phase": 3,
      "name": "Recovery + Injector",
      "files": ["recovery.js", "injector.js"],
      "tests": ["phase3-recovery.test.js", "phase3-injector.test.js"],
      "gate": "state machine transitions OK",
      "dependsOn": "phase2"
    },
    {
      "phase": 4,
      "name": "UX + Integration",
      "files": ["index.js"],
      "tests": ["phase4-intervention.test.js", "phase4-integration.test.js"],
      "gate": "/heartbeat status works",
      "dependsOn": "phase3"
    },
    {
      "phase": 5,
      "name": "System Testing",
      "files": [],
      "tests": ["system.test.js"],
      "gate": "node --test -> 104 pass",
      "dependsOn": "phase4"
    }
  ],
  "criticalRules": [
    "RUN verify-api.js BEFORE Phase 1 — confirms 4 unknown API behaviors",
    "Gate N must pass before Phase N+1 starts",
    "If gate fails, fix current phase before advancing",
    "Test files co-located with each phase's module, not deferred",
    "Project-local path: .opencode/plugins/smart-heartbeat-local/ (NOT ~/.config/opencode/plugins/)"
  ],
  "configTemplate": {
    "note": "OpenCode auto-discovers .opencode/plugins/*.js. NO opencode.json changes needed.",
    "altEntry": "file:///absolute/path/<project>/.opencode/plugins/smart-heartbeat.js"
  },
  "verifyCommands": [
    "node -c .opencode/plugins/smart-heartbeat-local/config.js",
    "node -c .opencode/plugins/smart-heartbeat-local/utils.js",
    "node -c .opencode/plugins/smart-heartbeat-local/state.js",
    "node -c .opencode/plugins/smart-heartbeat-local/monitor.js",
    "node -c .opencode/plugins/smart-heartbeat-local/recovery.js",
    "node -c .opencode/plugins/smart-heartbeat-local/injector.js",
    "node -c .opencode/plugins/smart-heartbeat-local/index.js",
    "node --test .opencode/plugins/smart-heartbeat-local/test/"
  ],
    "totalTestCount": 104,
    "testBreakdown": {
        "phase1_unit": 21,
        "phase2_unit": 24,
        "phase3_unit": 40,
        "phase4_integration": 10,
        "phase5_system": 9
    }
```

---

## 4. 檔案檢查清單

安裝完成後，預期目錄結構：

```
.opencode/plugins/
├── smart-heartbeat.js                  # OpenCode Desktop entry (wrapper)
└── smart-heartbeat-local/
    ├── index.js          (Phase 4)
    ├── config.js         (Phase 1)
    ├── utils.js          (Phase 1)
    ├── state.js          (Phase 2)
    ├── monitor.js        (Phase 2)
    ├── recovery.js       (Phase 3)
    ├── injector.js       (Phase 3)
    ├── verify-api.js     (Phase 1, 可選移除)
    └── test/
        ├── mock.js               (Phase 1 — shared infrastructure)
        ├── phase1-config.test.js
        ├── phase1-utils.test.js
        ├── phase2-state.test.js
        ├── phase2-monitor.test.js
        ├── phase3-recovery.test.js
        ├── phase3-injector.test.js
        ├── phase4-intervention.test.js
        ├── phase4-integration.test.js
        └── system.test.js
```

## 5. 疑難排解

| 症狀 | 原因 | 解法 |
|------|------|------|
| `require()` fail | 路徑錯誤 | 確認 `.opencode/plugins/smart-heartbeat.js` 存在且子目錄在相鄰位置 |
| `/heartbeat` 命令無回應 | plugin 未載入 | 確認 `.opencode/plugins/smart-heartbeat.js` 存在；嘗試 `file://` 絕對路徑 |
| `/heartbeat` 命令無回應 | ConfigInvalidError | 檢查 opencode.json 沒有 `"plugins"` (複數) key |
| 注入提示未出現 | event hook 未註冊 | 檢查 factory function 有註冊 `message.completed` handler |
| 測試 fail | mock 與實作不一致 | 確認 mock infrastructure 與 module exports 同步 |
| 全域 plugin 衝突 | v2 (global) vs v2-local 同時載入 | 全域 plugin 應 disable 避免雙重注入 |

---

> 文件變更記錄：初始版本 (2026-05-14)
