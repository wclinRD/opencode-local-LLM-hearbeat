# Smart Heartbeat Local LLM — 總 Plan

> **設計參考：** 詳細設計決策、state shape、config schema、prompt style 定義在 `2026-05-13-heartbeat-local-llm.md`。本總 plan 只含架構總覽與子 plan 串接。

## 目標

建立專為 local LLM (Gemma 4 4B, Qwen3.5, Qwen3.6) 設計的 Smart Heartbeat plugin，解決 context 壓力、tool 錯誤循環、復原後再次忘記、以及死亡螺旋等生產問題。

## 檔案結構

```
.opencode/plugins/smart-heartbeat-local/
├── index.js          # Entry + event router + lifecycle      ~90 lines  (Phase 4)
├── config.js         # Schema + validation + model profiles  ~195 lines (Phase 1)
├── state.js          # Session state + persistence + LRU     ~130 lines (Phase 2)
├── monitor.js        # Tool tracking + context + stuck + truncation detection  ~140 lines (Phase 2)
├── recovery.js       # State machine + death spiral + error  ~235 lines (Phase 3)
├── injector.js       # Prompt routing + templates + styles   ~100 lines (Phase 3)
└── utils.js          # sanitizeSessionID, log, timer, sleep  ~80 lines  (Phase 1)
```

每個 module 有明確定義的 exports 介面，跨 module 不直接存取相依 module 的內部狀態。

## 相依圖

```
           ┌──────────┐
           │ config.js │  (standalone — 無相依)
           └────┬─────┘
                │
           ┌────▼─────┐
           │ utils.js  │  (standalone — 無相依)  
           └────┬─────┘
                │
           ┌────▼─────┐
           │ state.js  │  相依: config, utils
           └────┬─────┘
                │
           ┌────▼──────┐
           │ monitor.js │  相依: state, config
           └────┬──────┘
                │
      ┌─────────┼─────────┐
      │         │         │
  ┌───▼───┐ ┌──▼────┐ ┌──▼──────┐
  │recov. │ │inject.│ │index.js │
  │.js    │ │js     │ │(wiring) │
  └───────┘ └───────┘ └─────────┘
```

## 實作順序

```
Phase 1 ── Foundation ──→ Phase 2 ── State+Monitor+Detect ──→ Phase 3 ── Recovery+Response ──→ Phase 4 ── UX+Integration ──→ Phase 5 ── System Testing
   │                          │                            │                            │                       │
   ├─ config.js               ├─ state.js                  ├─ recovery.js               ├─ index.js (complete)   ├─ S1: Full lifecycle
   ├─ utils.js                ├─ monitor.js                ├─ injector.js               ├─ /heartbeat commands   ├─ S2: Recovery pipeline
   ├─ index.js (skeleton)     │  └─ detectTruncation       └─ checkpoint:               ├─ operational UX        ├─ S3: Death spiral stop
   ├─ API verify plugin       └─ checkpoint:                  Gate #3:                  ├─ user intervention     ├─ S4: Injector routing
   └─ checkpoint:                Gate #2:                  State machine               └─ checkpoint:           ├─ S5: Tool stuck
       Gate #1:               Events flow +                  transitions,                      Gate #4:              ├─ S6: Mixed scenarios
       Plugin loads,          persistence works              prompts inject             All features integrated,  ├─ S7: Concurrent sessions
       config works           工具監控正確 +            + truncation detection     user commands work +       ├─ S8: Event storm
                               truncation detection                                          user intervention wired   └─ S9: Resource cleanup
```

**關鍵原則：** Gate N 必須通過才能開始 Phase N+1。若 Gate 失敗，回頭修正該 Phase 後再繼續。

## Sub-Plan 快速參考

| Phase | 檔案 | 主要產出 | 相依 | 實作行數 |
|-------|------|---------|------|---------|
| 1 | `01-foundation.md` | config.js, utils.js, verify-api.js, mock.js | 無 | ~380 impl |
| 2 | `02-state-monitoring.md` | state.js, monitor.js (含 detectTruncation) | Phase 1 done (Gate #1) | ~280 impl |
| 3 | `03-recovery-response.md` | recovery.js, injector.js | Gate #2 passed | ~330 impl |
| 4 | `04-ux-integration.md` | index.js (complete) + todo caching | Gate #3 passed | ~190 impl |
| 5 | `05-system-testing.md` | system.test.js (9 scenarios S1-S9) | Gate #4 passed | ~150 test |

**Gate 通過標準：**
- **Gate #1:** `node -c .opencode/plugins/smart-heartbeat-local/config.js && node -c .opencode/plugins/smart-heartbeat-local/utils.js` → 無錯誤 + verify-api.js 完整執行
- **Gate #2:** 驗證 plugin 可載入，`tool.started`/`tool.completed` 事件被記錄到 state，`detectTruncation` 正確識別 truncation
- **Gate #3:** 驗證 recovery state machine 6 個狀態轉換正確（需 mock timer）+ injector 可產生正確 prompt
- **Gate #4:** 實際在 OpenCode 中載入 plugin，/heartbeat status 輸出正確，使用者介入 handler 正常接線
- **Gate #5:** `node --test .opencode/plugins/smart-heartbeat-local/test/` → **104 tests all pass**（Phase 1-4 共 95 個 unit/integration + Phase 5 共 9 個 system = 104）

## API 驗證 (Phase 1 第一步)

開工前先執行獨立的 `verify-api.js` (~50 行)，確認 4 個未知 API 行為：

| API | 預期 | 若不符的影響 |
|-----|------|-------------|
| `client.session.prompt` | APPEND | 漸進提示 redesign |
| `tool.started` payload | 含 name, sessionID | Event handler 全部改寫 |
| `opencode.showToast` | 存在 | status UX 改寫入 log |
| `opencode.session.model` | string | Auto-detect 改用 env |

**驗證結果決定 main plugin 的設計。API verify 是 Phase 1 的第一步，未通過前不要繼續 Phase 1 的其他實作。**

### API 不符應變方案

| API | 若不符預期 | 應變方案 |
|-----|-----------|---------|
| `client.session.prompt` 是 REPLACE 而非 APPEND | injection 僅最後一次生效 | 改用 `client.session.appendMessage()`（若存在）或一次注入完整 context block |
| `tool.started` payload 不含 sessionID | Event router 無法 dispatch | 改用 `client.session.id` 或 fallback 為單一 session 模式 |
| `opencode.showToast` 不存在 | UX 通知失效 | 全部回退到 `console.log` + `warn()`，移除所有 toast 呼叫 |
| `opencode.session.model` 不是 string | Auto-detect 失效 | 全部使用 `process.env.OPENCODE_MODEL` 或預設 `gemma-4-4b` profile |

若任一 API 行為不符，先暫停實作，更新 plan 後再繼續。

## 系統測試（Phase 5）

9 個端到端場景覆蓋完整 plugin lifecycle（詳見 `05-system-testing.md`）:

| 場景 | 測試目標 |
|------|---------|
| **S1** | Full lifecycle: onStart→onStop，含 crash handler、event registration、timer cleanup |
| **S2** | Recovery pipeline: truncation→detect→inject→verify 完整流程 |
| **S3** | Death spiral detection: 6 次重複 → recovery stop → manual reset |
| **S4** | Injector routing matrix: 7 types × 3 styles × 4 levels |
| **S5** | Tool stuck detection: threshold→warn→manual→auto-resolve |
| **S6** | Mixed scenarios: interleaved events, state loss, cleanup |
| **S7** | **Stress: Concurrent Sessions**: 5+ sessions interleaved, LRU eviction |
| **S8** | **Stress: Rapid-Fire Event Storm**: 100 events in 1s, no crash |
| **S9** | **Stress: Memory & Resource Cleanup**: timers, states, onStop idempotent |

## 測試總覽

| 層級 | Phase | 測試檔案 | 數量 |
|------|-------|---------|------|
| Unit | 1 | `phase1-config.test.js`, `phase1-utils.test.js` | 21 |
| Unit | 2 | `phase2-state.test.js`, `phase2-monitor.test.js` | 24 (原有 18 + 新增 4 detectTruncation + new 2 loadFromPersistence) |
| Unit | 3 | `phase3-recovery.test.js`, `phase3-injector.test.js` | 40 (原 39 + 新增 1 shouldAttemptRecovery guard) |
| Integration | 4 | `phase4-intervention.test.js`, `phase4-integration.test.js` | 10 |
| System | 5 | `system.test.js` | 9 |
| **Total** | 1-5 | 9 test files | **104** (21+24+40+10+9) |

## 設計參考對照

詳細設計內容（state shape、config schema、prompt 模板、錯誤分級、架構圖）在 `2026-05-13-heartbeat-local-llm.md`。各 sub-plan 會標註需要參考的 section 編號。
