# Phase 5 — System-Level Testing

**目標：** 驗證 plugin 在真實 OpenCode 環境中的端到端行為。這些測試跨越所有 module，確保元件整合正確。

**前置條件：** Gate #4 通過（所有模組開發完成）

**檔案：** `task/system.test.js`

---

## TODO 列表

LLM 實作時依序執行，每完成一項用 `todowrite` 設為 completed：

| # | 任務 | 測試場景 | 行數估計 | 類型 |
|---|------|---------|---------|------|
| 5.1 | S1 — Full Lifecycle: onStart→dispatch events→onStop, crash handler install/remove, handler registration | system.test.js | ~25 | 端到端 |
| 5.2 | S2 — Recovery Pipeline (E2E): truncation→shouldAttempt→executeRecovery→tool.started verify→assessQuality | system.test.js | ~30 | 端到端 |
| 5.3 | S3 — Death Spiral + Recovery Stop: 3x failure in window→deathSpiral=true→recoveryState=stopped | system.test.js | ~25 | 端到端 |
| 5.4 | S4 — User Intervention Override: recovery injected→user message→counters reset→60s cooldown→120s auto-resume | system.test.js | ~25 | 端到端 |
| 5.5 | S5 — Tool Error Escalation Chain: tool.error×1→L1 / ×3→L2 / ×6→L3 / ×7→L4 / ×8→death spiral trigger | system.test.js | ~25 | 端到端 |
| 5.6 | S6 — macOS Sleep/Wake Recovery: fake timer sleep 3min→callback skipped via isWakeAfterSleep→orphan cleanup | system.test.js | ~20 | 端到端 |
| 5.7 | **S7 — Stress: Concurrent Sessions**: 5+ sessions interleaved, LRU eviction, independent timers | system.test.js | ~30 | 壓力 |
| 5.8 | **S8 — Stress: Rapid-Fire Event Storm**: 100 events in 1s, no crash, state consistency | system.test.js | ~25 | 壓力 |
| 5.9 | **S9 — Stress: Memory & Resource Cleanup**: activeTimers, session states, LRU cleanup after onStop | system.test.js | ~20 | 壓力 |
| 5.10 | **Gate #5 驗證** — `node --test .opencode/plugins/smart-heartbeat-local/test/` → 104 pass / `node -c` 所有 7 modules | — | — | 檢查點 |

**實作順序：** 5.1→5.2→5.3→5.4→5.5→5.6→5.7→5.8→5.9→5.10

---

## 系統測試案例（9 大場景）

### S1: Full Lifecycle

驗證 plugin 從載入到卸載的完整生命週期。

```
onStart → crash handler installed → config loaded → event handlers registered
  → model profile auto-detected → dispatch tool.started event
  → dispatch tool.completed event → onStop → timers cleared
  → handlers unregistered → crash handler removed
```

**測試方法：** 載入 plugin (require)，依序呼叫 onStart/onStop，觀察 side effect。

```javascript
const plugin = require('../index.js')
await plugin.onStart(mockOpencode, mockClient)
assert(process.listeners('uncaughtException').length > 0)
assert(mockClient.handlerCount >= 4)  // events registered
await plugin.onStop()
assert.strictEqual(activeTimers.size, 0)
```

### S2: Recovery Pipeline (End-to-End)

驗證 truncation → detect → recovery inject → verify 的完整 pipeline。

```
1. tool.completed (todos changed → truncation 推測)
2. shouldAttemptRecovery → true
3. executeRecovery → inject prompt → start verification timer
4. tool.started fires → clear timers → handleRecoverySuccess
5. assessRecoveryQuality → tool is not repeated → quality=good
6. detectDeathSpiral → not triggered → recoveryState=idle
```

**測試方法：** Mock 事件順序，檢查每個階段的 state 轉換。使用 fake timers 控制 verification timer 的觸發時機。

### S3: Death Spiral + Recovery Stop

驗證死亡螺旋偵測正確停止 recovery。

```
1. Truncation → recovery injected → timer expires (no tool.started)
2. handleRecoveryFailure → escalate → retry
3. Repeat 3 times in <5min window → detectDeathSpiral = true
4. recoveryState = 'stopped', no more recovery attempts
```

**測試方法：** Mock 多次 truncation 事件，在短時間內觸發，驗證 deathSpiral flag 和 recoveryState。

### S4: User Intervention Override

驗證使用者可以隨時中斷並重置系統。

```
1. recovery 進行中 (recoveryState=injected)
2. user message 到來 (handleUserMessage)
3. 所有 counters reset (recoveryAttempts=0, deathSpiral=false, toolErrorCount=0)
4. 60s cooldown 啟動 (heartbeatCooldownUntil = now+60000)
5. shouldSkipInjection → true (cooldown active)
6. 120s idle → auto-resume → shouldSkipInjection → false
```

**測試方法：** 設定 state 為 recovery 中，觸發 handleUserMessage，檢查全部 counters 歸零。

### S5: Tool Error Escalation Chain

驗證 4 級錯誤 escalation 正確觸發。

```
1. tool.error x1 → toolErrorCount=1 → level 1 (retry)
2. tool.error x2-3 → toolErrorCount=3 → level 2 (change method)
3. tool.error x4-6 → toolErrorCount=6 → level 3 (tool-type aware)
4. tool.error x7+ → toolErrorCount=7 → level 4 (web search)
5. 第 8 次後 detectDeathSpiral 檢查 → tool 錯誤螺旋觸發
```

**測試方法：** 依序 mock 7 次 tool.error，每次檢查 `analyzeToolErrors().level`。

### S6: macOS Sleep/Wake Recovery

驗證睡眠喚醒後 timer 正確處理。

```
1. setSafeTimeout(fn, 60000) — schedule timer
2. 模擬 sleep 3 分鐘 (advanceTime(180000))
3. timer callback 觸發 → isWakeAfterSleep → true → callback 跳過
4. 新的 tool.started 到來 → 正常處理
5. onStart 時 activeTimers 不為空 → 清理 orphaned timers
```

**測試方法：** 使用 fake timers，`advanceTime(180000)` 模擬睡眠，檢查 callback 是否被跳過。

---

### S7: Stress — Concurrent Session Handling

驗證多個 session 同時存在時，state 與 timer 獨立隔離。

```
1. 建立 5 個 session (alpha/beta/gamma/delta/epsilon)
2. 每個 session dispatch 交錯的 tool.started event
3. 每個 session 各自觸發 recovery (mock truncation)
4. 驗證 state 獨立: session-alpha 的 toolCallHistory 不影響 session-beta
5. LRU eviction: 建立 55+ session → 驗證最舊 session 被移除
6. 驗證 timer 各自獨立: session-alpha 的 recovery timer 到期不影響 session-beta
```

**測試方法：** 在單一 test 中建立 5+ session state，交錯 dispatch events。使用 fake timers 驗證 timer 隔離。LRU 驗證透過建立超過 maxSessions 的 session ID。

```javascript
// Concurrent: 5 sessions independent
const sessions = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
for (const s of sessions) createOrGetState(s)

// Dispatch tool events interleaved across sessions
sessions.forEach((s, i) => {
  handleToolEvent(s, 'tool.started', { name: 'edit', sessionID: s })
})
// Each session's toolCallHistory independently tracks its own events
assert.strictEqual(getState('alpha').toolCallHistory.length, 1)
assert.strictEqual(getState('beta').toolCallHistory.length, 1)

// LRU: create 55+ sessions evicts oldest
for (let i = 0; i < 55; i++) createOrGetState(`excess-${i}`)
assert.strictEqual(getState('alpha'), undefined)  // evicted
```

### S8: Stress — Rapid-Fire Event Storm

驗證大量事件在短時間內送達時 plugin 的穩定性。

```
1. 1 秒內依序 dispatch 100 個 tool.started event
2. 所有 state 操作不拋出 exception
3. 最終 toolCallHistory 長度正確 (100)
4. context estimation 在大量 history 下仍正常
5. 無事件遺失 — 逐一驗證 toolCallHistory 內容
```

**測試方法：** 使用 `for` 迴圈模擬連發事件，`setTimeout` 控制時間間隔在 10ms 內。檢查 state 完整性和 exception-free 執行。

```javascript
// Rapid-fire: 100 events in rapid succession
const sid = 'rapidfire'
createOrGetState(sid)
for (let i = 0; i < 100; i++) {
  handleToolEvent(sid, 'tool.started', { name: 'edit', sessionID: sid })
}
const state = getState(sid)
assert.strictEqual(state.toolCallHistory.length, 100)
assert(estimateContextTokens(state, DEFAULT_CONFIG) > 4000)  // estimation handles load
```

### S9: Stress — Memory & Resource Cleanup

驗證 plugin 卸載後資源完全釋放，無 timer 殘留。

```
1. onStart → 多個 session state 建立 → 多個 timers 啟動
2. 模擬 onStop 觸發
3. 驗證 activeTimers Set 為空 (clearAllTimers 已呼叫)
4. 驗證 LRU cleanup 正確刪除過期 session
5. 驗證 onStop 可多次安全呼叫 (idempotent)
```

**測試方法：** 在 test 中呼叫 onStart、註冊 timers、建立 session。呼叫 onStop 後逐一確認 cleanup。

```javascript
// Cleanup: onStop clears everything
await plugin.onStart(mockOpencode, mockClient)
const sid = 'cleanup-test'
createOrGetState(sid)
setSafeTimeout(() => {}, 50000)  // register timer
await plugin.onStop()
assert.strictEqual(activeTimers.size, 0)  // all timers cleared

// onStop idempotent — second call no error
await plugin.onStop()

// LRU cleanup: persistence debounce + stale entries
const staler = createOrGetState('stale-entry')
// advance time past cleanupAgeHours...
// (depends on persistence implementation)
```

## 測試檔案 structure

```
.opencode/plugins/smart-heartbeat-local/test/
├── system.test.js      # S1-S9 system-level tests (~230 行)
```

## 執行

```bash
# 全部測試 (104 cases)
node --test .opencode/plugins/smart-heartbeat-local/test/

# 單一模組測試
node --test .opencode/plugins/smart-heartbeat-local/test/phase1-config.test.js

# 系統測試
node --test .opencode/plugins/smart-heartbeat-local/test/system.test.js

# 語法驗證
for f in .opencode/plugins/smart-heartbeat-local/*.js; do node -c "$f" 2>/dev/null && echo "OK: $f" || echo "FAIL: $f"; done
```

## 覆蓋率驗證

| 類別 | 數量 | 位置 |
|------|------|------|
| Unit (Phase 1) | 21 | phase1-config.test.js + phase1-utils.test.js |
| Unit (Phase 2) | 24 | phase2-state.test.js + phase2-monitor.test.js (含 detectTruncation, loadFromPersistence) |
| Unit (Phase 3) | 40 | phase3-recovery.test.js + phase3-injector.test.js |
| Integration (Phase 4) | 10 | phase4-intervention.test.js + phase4-integration.test.js |
| System (Phase 5) | 9 | system.test.js |
| **總計** | **104** | **All test files** |

---

## Checkpoint Gate #5

通過條件：
1. 所有 phase 單元測試 (21+24+40+10 = 95) pass
2. 系統測試 9/9 pass → 總計 **104/104 pass**
3. `node -c` 對所有 7 個 module 通過
4. `for f in .opencode/plugins/smart-heartbeat-local/*.js; do node -c "$f"; done` → 全部 OK

**Gate #5 通過 = 全部 Phase 實作完成，可部署至 OpenCode。**
