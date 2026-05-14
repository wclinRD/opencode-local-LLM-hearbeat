# Archive — 舊版計劃文件

此目錄存放 Smart Heartbeat Local LLM plugin 計劃的舊版檔案，作為歷史參考。

## 檔案說明

| 檔案 | 歸檔日期 | 被取代者 | 原因 |
|------|---------|---------|------|
| `05-testing.md.orig` | 2026-05-14 | `05-system-testing.md` | 原「Phase 5 Testing」拆分為各 Phase 獨立測試（Phase 1-4 每階段含測試）+ 保留 Phase 5 做系統測試。原單一 testing.md 不再適用 |
| `2026-05-13-smart-heartbeat-tool-monitor.md` | 2026-05-14 | `2026-05-13-heartbeat-local-llm.md` + 5 個 Phase sub-plan | 初版設計（僅 tool monitor 強化）被完整設計文件取代。新版涵蓋 recovery state machine、death spiral、model scale 系統等 |

## 不使用刪除的原因

- 保留舊版文件以供追溯設計演進
- `05-testing.md.orig` 中的 mock infrastructure 設計仍有參考價值
- `2026-05-13-smart-heartbeat-tool-monitor.md` 記錄了最早的設計意圖

## 對應的新版文件

- `05-system-testing.md` → Phase 5 系統測試
- `01-foundation.md` ~ `04-ux-integration.md` → Phase 1-4 各階段（含對應測試）
- `2026-05-13-heartbeat-local-llm.md` → 完整設計參考
- `index.md` → 總 plan master 索引
- `review-complete.md` → 審查結果與追蹤
