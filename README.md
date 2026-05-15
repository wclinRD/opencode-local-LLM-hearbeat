# opencode-local-LLM-hearbeat

Solve local LLM cannot continue process task — Smart Heartbeat Plugin for OpenCode.

專為 local LLM (Gemma 4 4B, Qwen3.5, LocoOperator 等) 設計的 Smart Heartbeat plugin。
解決 context 壓力、tool 錯誤循環、復原後再次忘記、以及死亡螺旋等生產問題。

## 目錄結構

```
opencode-local-LLM-hearbeat/
├── plugin/
│   ├── smart-heartbeat-local.js              # Global v3 plugin (reference)
│   ├── smart-heartbeat.js                    # OpenCode Desktop plugin entry (wrapper)
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

## 安裝步驟 (人類版)

> 先 clone 此 repo：`git clone https://github.com/wclinRD/opencode-local-LLM-hearbeat.git /tmp/opencode-hearbeat && cd /tmp/opencode-hearbeat`
>
> 以下指令假設你已在 clone 後的 repo 目錄內執行。
>
> 目標專案的 `.opencode/` 路徑請自行替換 `<target-project>`。

### 1. 複製 Plugin 到你的專案

```bash
# 複製子目錄模組
cp -r plugin/smart-heartbeat-local <target-project>/.opencode/plugins/

# 複製 OpenCode Desktop entry point
cp plugin/smart-heartbeat.js <target-project>/.opencode/plugins/
```

### 2. 註冊 Plugin

OpenCode 會自動從 `.opencode/plugins/` 載入 plugin，**無需修改 `opencode.json`**。  
若想明確註冊，可在專案 `opencode.json` 的 `plugin` 陣列中加入 `file://` 路徑：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///absolute/path/to/<target-project>/.opencode/plugins/smart-heartbeat.js"
  ]
}
```

> ⚠️ `file://` 路徑需使用**絕對路徑**。若專案移動位置，需更新此路徑。

完整選項請參考 `docs/plans/DEPLOY.md`。

### 3. 執行測試驗證

```bash
# 語法驗證（在目標專案根目錄執行）
for f in .opencode/plugins/smart-heartbeat-local/*.js; do node -c "$f" 2>/dev/null && echo "OK: $f" || echo "FAIL: $f"; done

# 執行全部 104 個測試
node --test .opencode/plugins/smart-heartbeat-local/test/
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

## 推薦搭配：Self-Reflection 自動反省 Skill

> 🔗 [opencode-auto-reflection](https://github.com/wclinRD/opencode-auto-reflection) — 讓 OpenCode agent 擁有自動學習反思能力

Heartbeat 負責「續行未完成的任務」，self-reflection 負責「從錯誤和成功中學習」。
兩者搭配使用可形成完整的**任務續行 + 自動反省迴圈**：

### 整合效果

```
Heartbeat 續行觸發
  → 檢查 self-reflection 是否正在反省中（reflecting flag）
    → 是：等待反省完成，不中斷反省流程
    → 否：正常執行續行任務
  → 反省完成後才繼續執行任務（順序保證）
  → 續行後不重置反省深度計數器（防止無限遞迴）
```

### 對比：只有 Heartbeat vs Heartbeat + Self-Reflection

| 情境 | 只有 Heartbeat | 加上 Self-Reflection |
|------|---------------|-------------------|
| Session 逾時續行 | ✅ 自動續行 | ✅ 自動續行 |
| 續行時正在反省 | ❌ 反省被打斷 | ✅ 反省狀態保留 |
| 工具報錯後反省 | ❌ 無反省能力 | ✅ L1 即時分析錯誤原因 |
| 跨 session 學習 | ❌ 無學習能力 | ✅ L2 模式提取跨 session 比對 |
| 技能自動演化 | ❌ 靜態 skill | ✅ 自動產生新 skill 改善未來 |
| 死亡螺旋迴圈 | ✅ 5 種偵測方法 | ✅ 學習螺旋模式後自動預防 |

### 安裝 Self-Reflection Skill

```bash
# 從 auto-reflection 倉庫複製 skill
git clone https://github.com/wclinRD/opencode-auto-reflection.git /tmp/opencode-reflection
cp -r /tmp/opencode-reflection/skills/self-reflection ~/.agents/skills/
cp /tmp/opencode-reflection/reflection-log.jsonl ~/.opencode/

# 驗證
ls ~/.agents/skills/self-reflection/SKILL.md     # 應存在
ls ~/.opencode/reflection-log.jsonl               # 應存在
```

安裝後在 OpenCode TUI 中載入：

```
/self-reflection
```

或加入 CLAUDE.md 自動載入：

```yaml
on_start:
  - skill(name: "self-reflection")
```

---

## 更多文件

- 完整設計文件: `docs/plans/2026-05-13-heartbeat-local-llm.md`
- 部署指南: `docs/plans/DEPLOY.md`
- Code Review: `docs/plans/review-complete.md`
- Self-Reflection 整合: [opencode-auto-reflection](https://github.com/wclinRD/opencode-auto-reflection)

---

## LLM 安裝指引 (給 LLM Agent 閱讀)

以下區塊設計給 codegen agent (Claude Code / Codex CLI / OpenCode / Gemini CLI) 直接讀取並執行。

### 這是什麼

`smart-heartbeat-local` 是一個 OpenCode plugin，專為 **local LLM** (Gemma 4 4B、Qwen3.5、Phi、Llama 等) 設計。

**要安裝的 agent 請注意：你的 cwd 就是目標專案根目錄。** 所有相對路徑都以目標專案根目錄為基準。

### 安裝流程

**Step 0: 檢查環境**

<!-- 以下為檢查清單，不是有效 JSON。每個檢查項是獨立記錄，LLM agent 依序執行。 -->

```
檢查 1: Node.js 版本
  指令: node --version
  預期: v18.x 或更高

檢查 2: OpenCode 版本
  指令: opencode --version
  預期: 1.14.0 或更高（若指令不存在，跳過此檢查）

檢查 3: 目標專案
  指令: ls .opencode/opencode.json
  預期: 檔案存在（若不存在，代表可能不是 OpenCode 專案根目錄）
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
# 複製子目錄模組
cp /tmp/opencode-hearbeat/plugin/smart-heartbeat-local/*.js .opencode/plugins/smart-heartbeat-local/

# 複製 OpenCode Desktop entry point (wrapper)
cp /tmp/opencode-hearbeat/plugin/smart-heartbeat.js .opencode/plugins/
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

OpenCode Desktop 會**自動載入** `.opencode/plugins/` 目錄中的 `.js` 檔案，因此檔案複製完成後即可運作。  
無需手動修改 `opencode.json`。

若想**明確註冊**（或你的環境不支援自動掃描），在專案 `opencode.json` 的 `plugin` 陣列中加入：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///absolute/path/to/<target-project>/.opencode/plugins/smart-heartbeat.js"
  ]
}
```

> ⚠️ `file://` 路徑需使用**絕對路徑**。
> ⚠️ 若同時使用 auto-discovery + `file://`，wrapper 內建防重複初始化 guard，不會重複註冊事件。

**不要使用 `"plugins"` (複數) key** — OpenCode 不支援此 key，會導致 `ConfigInvalidError`。

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

若 `/heartbeat status` 無回應，檢查：
1. `.opencode/plugins/smart-heartbeat.js` 是否存在
2. OpenCode 是否自動掃描 `.opencode/plugins/`（部分環境需要 `file://` 絕對路徑註冊）

### 選擇性安裝：Self-Reflection Skill（推薦搭配）

如果你也希望 agent 能從錯誤中學習、自動產生技能改善未來行為，建議同時安裝 [opencode-auto-reflection](https://github.com/wclinRD/opencode-auto-reflection)：

```bash
# 在目標專案根目錄執行
git clone https://github.com/wclinRD/opencode-auto-reflection.git /tmp/opencode-reflection
mkdir -p ~/.agents/skills/self-reflection/
cp /tmp/opencode-reflection/skills/self-reflection/SKILL.md ~/.agents/skills/self-reflection/
cp /tmp/opencode-reflection/reflection-log.jsonl ~/.opencode/
```

安裝後，Heartbeat 會自動與 self-reflection 協作：
- 續行時檢查 `reflecting` flag，不中斷反省流程
- 反省完成後才繼續執行續行任務
- 續行後不重置反省深度計數器

### 關鍵規則

```
1. 目標專案的路徑 = 你的 cwd。所有相對路徑以此為基準。
2. 不要安裝到 ~/.config/opencode/plugins/ — 使用 .opencode/plugins/
3. Step 5 (語法驗證) 必須全部通過，才能進行 Step 6
4. 如果測試失敗，先重新確認 Step 3-4 複製是否完整，不要直接改 plugin 程式碼
5. OpenCode plugin API: module.exports = async (ctx) => { ... } — 單一 factory function
6. 不要使用 "plugins" (複數) key in opencode.json — 不支援，會 ConfigInvalidError
7. wrapper 內建防重複初始化 guard，auto-discovery 與 file:// 並存沒問題
8. 如安裝 self-reflection，Heartbeat 會自動尊重 reflecting flag，不需額外設定
```

### 安裝後檢查清單

| # | 檢查項 | 指令 | 成功條件 |
|---|--------|------|---------|
| 1 | Plugin 檔案 (子目錄) | `ls .opencode/plugins/smart-heartbeat-local/*.js` | 8 個 .js 檔案 |
| 2 | Plugin 檔案 (wrapper) | `ls .opencode/plugins/smart-heartbeat.js` | 檔案存在 |
| 3 | 語法正確 | `for f in .opencode/plugins/smart-heartbeat* .opencode/plugins/smart-heartbeat-local/*.js; do node -c "$f" 2>/dev/null || echo "BROKEN: $f"; done` | 無 `BROKEN:` 輸出 |
| 4 | Plugin 可載入 | `node -e "require('.opencode/plugins/smart-heartbeat.js')"` | 無錯誤 (exit 0) |
| 5 | 測試通過 | `node --test .opencode/plugins/smart-heartbeat-local/test/` | 104 pass, 0 fail |
| 6 | OpenCode 回應 | 在 OpenCode 中執行 `/heartbeat status` | 顯示完整狀態 |

### 聯絡設計文件

- `docs/plans/2026-05-13-heartbeat-local-llm.md` — 完整設計原理
- `docs/plans/DEPLOY.md` — 完整部署選項 (含人類版+LLM版)
