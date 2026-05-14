# Smart Heartbeat — Tool 監管強化 (Project Version) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build project-specific smart-heartbeat plugin with full tool usage monitoring, error tracking, and enhanced stuck detection.

**Architecture:** Reuse global smart-heartbeat.js as base. Add 4 new monitoring dimensions: tool completion tracking, tool error counting, repeated-call detection, and dual-signal stuck detection (todo + tool). Plugin registers in project-level `.opencode/plugins/` with project-level `opencode.json`.

**Tech Stack:** JavaScript, OpenCode Plugin API

**Files:**
- Create: `.opencode/plugins/smart-heartbeat.js`
- Modify: `.opencode/opencode.json`
- Reference: `~/.config/opencode/plugins/smart-heartbeat.js` (global version)

---

## Key Improvements from Global Version

| Feature | Global Version | Project Version |
|---------|---------------|-----------------|
| tool.started | Cancels debounce only | + records tool name, timestamp, increments call count |
| tool.completed | **Missing** | NEW: records completion, resets error count |
| tool.error | **Missing** | NEW: counts errors, stops on threshold (5) |
| Repeated tool detect | None | NEW: flags >8 same-tool calls as stuck |
| Stuck detection | Todo-only (JSON snapshots) | Todo + tool + idle-time triple signal |
| Continuation prompt | Static | Adapts: includes error context, stuck reason |
| Logging | /tmp/smart-heartbeat.log | + `warn` level for tool anomalies |

---

### Task 1: Create `.opencode/plugins/smart-heartbeat.js`

**Files:**
- Create: `.opencode/plugins/smart-heartbeat.js`

- [ ] **Step 1: Copy global version as base**

Copy from `~/.config/opencode/plugins/smart-heartbeat.js` to `.opencode/plugins/smart-heartbeat.js`

- [ ] **Step 2: Expand session state with tool tracking fields**

Add to `getState()`:
```javascript
state = {
  // ... existing fields ...
  toolCallHistory: [],       // [{name, time, status}], max 10
  toolErrorCount: 0,         // consecutive tool errors
  lastToolName: null,        // name of most recent tool call
  lastToolTime: null,        // timestamp of most recent tool call
  repeatedToolCount: 0,      // consecutive same-tool calls
  toolCallCount: 0,          // total tool calls this cycle
};
```

- [ ] **Step 3: Add tool.completed and tool.error handlers**

Add to `event` handler after the tool-running block:
```javascript
// Tool completed — record success
if (event.type === "tool.completed") {
  const toolName = event.properties?.name || event.properties?.tool || "unknown";
  log("  tool.completed:", toolName);
  const state = getState(sid);
  state.lastToolName = toolName;
  state.lastToolTime = Date.now();
  state.toolCallHistory.push({ name: toolName, time: Date.now(), status: "ok" });
  if (state.toolCallHistory.length > 10) state.toolCallHistory.shift();
  state.toolErrorCount = 0; // reset error count on success
}

// Tool error — count up, stop at threshold
if (event.type === "tool.error") {
  const toolName = event.properties?.name || "unknown";
  const errMsg = event.properties?.error || event.properties?.message || "";
  warn(`tool.error: ${toolName} — ${errMsg}`);
  const state = getState(sid);
  state.toolErrorCount++;
  state.lastToolTime = Date.now();
  state.toolCallHistory.push({ name: toolName, time: Date.now(), status: "error" });
  if (state.toolCallHistory.length > 10) state.toolCallHistory.shift();
  
  // Auto-stop on 5 consecutive errors
  if (state.toolErrorCount >= 5) {
    state.enabled = false;
    cancelAll(sid);
    warn("tool.error threshold reached (5), disabling continuation");
    showToast("工具連續錯誤 5 次，已停止自動續行", "error");
  }
}
```

- [ ] **Step 4: Add repeated-call detection to tool.started handler**

Modify the tool-running block to also track repeated calls:
```javascript
if (isToolRunning) {
  const sidTool = event.properties?.sessionID;
  if (sidTool) {
    const stateTool = getState(sidTool);
    if (stateTool.debounce) {
      clearTimeout(stateTool.debounce);
      stateTool.debounce = null;
    }
    // NEW: repeated-call detection
    const toolName = event.properties?.name || "unknown";
    if (stateTool.lastToolName === toolName) {
      stateTool.repeatedToolCount++;
      stateTool.toolCallCount++;
      if (stateTool.repeatedToolCount > 5) {
        warn(`可能的 tool 迴圈: ${toolName} x${stateTool.repeatedToolCount}`);
      }
    } else {
      stateTool.repeatedToolCount = 0;
      stateTool.toolCallCount++;
    }
    stateTool.lastToolName = toolName;
    stateTool.lastToolTime = Date.now();
  }
}
```

- [ ] **Step 5: Enhance stuck detection with tool signals**

Replace `isTodoProgressStalled` with multi-signal detection:
```javascript
const MAX_REPEATED_TOOL = config?.maxRepeatedTool ?? 8;
const MAX_TOOL_ERRORS = config?.maxToolErrors ?? 5;
const MAX_IDLE_SECONDS = config?.maxIdleSeconds ?? 60;

function checkStuckState(state, sessionID, todos) {
  const toolLoop = state.repeatedToolCount >= MAX_REPEATED_TOOL;
  const toolErrors = state.toolErrorCount >= MAX_TOOL_ERRORS;
  const noActivity = state.lastToolTime && (Date.now() - state.lastToolTime > MAX_IDLE_SECONDS * 1000);
  const todoStalled = isTodoProgressStalled(sessionID, todos);

  if (toolLoop) return { stuck: true, reason: "tool_loop", detail: `${state.lastToolName} x${state.repeatedToolCount}` };
  if (toolErrors) return { stuck: true, reason: "tool_errors", detail: `${state.toolErrorCount} consecutive errors` };
  if (todoStalled && noActivity) return { stuck: true, reason: "idle", detail: `no activity for ${MAX_IDLE_SECONDS}s` };
  if (todoStalled && state.toolCallCount > 3) return { stuck: true, reason: "todo_stalled", detail: "todos unchanged despite tool activity" };
  return { stuck: false, reason: null, detail: null };
}
```

- [ ] **Step 6: Adapt continuation prompt based on tool context**

Modify `injectContinuation` to include tool context:
```javascript
// Build context-aware continuation message
let continuationText = `還有 ${incomplete.length} 個任務未完成：\n${taskNames}`;

// Add tool context
if (state.toolErrorCount > 0) {
  continuationText += `\n\n⚠️ 注意：最近有 ${state.toolErrorCount} 次工具呼叫失敗，請檢查錯誤原因。`;
}
if (state.repeatedToolCount > 5) {
  continuationText += `\n\n⚠️ 注意：${state.lastToolName} 已被連續呼叫 ${state.repeatedToolCount} 次，嘗試不同方法。`;
}
if (state.toolCallCount > 20) {
  continuationText += `\n\n⚠️ 本次已進行 ${state.toolCallCount} 次工具呼叫，注意 context 用量。`;
}
```

- [ ] **Step 7: Reset tool tracking on continuation injection**

After injection, reset tool counters:
```javascript
state.toolCallHistory = [];
state.toolErrorCount = 0;
state.repeatedToolCount = 0;
state.toolCallCount = 0;
state.lastToolName = null;
```

- [ ] **Step 8: Verify syntax**

Run: `node -c .opencode/plugins/smart-heartbeat.js`
Expected: No output (success)

- [ ] **Step 9: Commit**

```bash
git add .opencode/plugins/smart-heartbeat.js
git commit -m "feat: project smart-heartbeat with tool monitoring"
```

---

### Task 2: Update `.opencode/opencode.json`

**Files:**
- Modify: `.opencode/opencode.json`

- [ ] **Step 1: Register plugin**

Replace content:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["smart-heartbeat", {
      "allowAllAgents": true,
      "countdownSeconds": 15,
      "minIntervalMs": 45000,
      "maxStuckCycles": 5,
      "maxToolErrors": 5,
      "maxRepeatedTool": 8,
      "maxIdleSeconds": 60,
      "skillHints": [
        { "name": "openmeteo-weather-checker", "desc": "查詢天氣" },
        { "name": "smart-heartbeat-helper", "desc": "Heartbeat 續行指引" }
      ]
    }]
  ]
}
```

Note: Using plugin name "smart-heartbeat" — OpenCode resolves this to `.opencode/plugins/smart-heartbeat.js` because it looks in the project's plugin directory before global plugins. Or use explicit path `./plugins/smart-heartbeat.js`.

- [ ] **Step 2: Verify JSON syntax**

Run: `node -e "JSON.parse(require('fs').readFileSync('.opencode/opencode.json','utf8'))"`
Expected: No error

- [ ] **Step 3: Commit**

```bash
git add .opencode/opencode.json
git commit -m "chore: register project smart-heartbeat plugin"
```

---

### Task 3: Verify Plugin Loads

**Files:**
- Check: Both files exist, syntax OK

- [ ] **Step 1: Full syntax check**

Run: `node -c .opencode/plugins/smart-heartbeat.js && echo "OK"`

Expected: `OK`

- [ ] **Step 2: Verify file structure**

Run: `ls -la .opencode/plugins/smart-heartbeat.js .opencode/opencode.json`

Expected: Both files exist

- [ ] **Step 3: Summary**

Files:
- Created: `.opencode/plugins/smart-heartbeat.js` (tool monitoring plugin)
- Modified: `.opencode/opencode.json` (plugin registration + config)

Key improvements over global version:
- tool.completed / tool.error event handling
- Repeated tool call detection (loop prevention)
- Dual-signal stuck detection (todo + tool + idle)
- Context-aware continuation prompts
- Configurable thresholds
