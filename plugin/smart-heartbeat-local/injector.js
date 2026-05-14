// injector.js — Prompt Routing + Templates + Injection
//
// Exports:
//   determinePromptType, selectPromptTemplate, buildInjectPrompt,
//   injectContinuation, INJECTOR_ROUTES

const { getPromptStyle, PROMPT_STYLES } = require('./config')
const { getLogger } = require('./utils')
const { analyzeToolErrors, getRecoveryPrompt } = require('./recovery')
const { checkStuckState } = require('./monitor')

// === Task 3.9: INJECTOR_ROUTES ===
const INJECTOR_ROUTES = {
  recovery:           { needsLevel: true,  styleAware: true,  group: 'recovery' },
  tool_error:         { needsLevel: true,  styleAware: true,  group: 'toolError' },
  tool_error_escalated: { needsLevel: true,  styleAware: true,  group: 'toolError' },
  tool_error_search:  { needsLevel: false, styleAware: true,  group: 'toolError' },
  context_pressure:   { needsLevel: false, styleAware: true,  group: 'context' },
  stuck:              { needsLevel: false, styleAware: true,  group: 'stuck' },
  normal:             { needsLevel: false, styleAware: true,  group: 'continuation' },
}

// === Task 3.9: determinePromptType — 5 種情境優先級 ===
function determinePromptType(state, todos, config) {
  // Priority 1: Recovery
  if (state.recoveryState !== 'idle') return 'recovery'

  // Priority 2: Tool error
  const analysis = analyzeToolErrors(state, config)
  state.toolErrorAnalysis = analysis
  if (analysis.level >= 1) {
    if (analysis.level >= 4) return 'tool_error_search'
    if (analysis.level >= 2) return 'tool_error_escalated'
    return 'tool_error'
  }

  // Priority 3: Context pressure
  if (state.contextWarnings >= 3) return 'context_pressure'

  // Priority 4: Stuck
  const stuck = checkStuckState(state, todos, config)
  if (stuck.stuck) return 'stuck'

  // Priority 5: Normal continuation
  return 'normal'
}

// === Task 3.10: selectPromptTemplate — routing matrix ===
function selectPromptTemplate(promptType, promptStyle, level, state, todos) {
  const route = INJECTOR_ROUTES[promptType]
  if (!route || !promptStyle) return ''

  if (route.group === 'recovery') {
    return getRecoveryPrompt(level || 0, todos, state, promptStyle)
  }

  if (route.group === 'toolError') {
    if (!route.needsLevel) return promptStyle.toolErrorL4
    const lvl = Math.min(Math.max(level || 1, 1), 4)
    let tpl = promptStyle[`toolErrorL${lvl}`] || promptStyle.toolErrorL1
    if (level >= 3 && state.toolErrorAnalysis?.toolType) {
      tpl = tpl.replace('{suggestion}', buildTypeSuggestion(state.toolErrorAnalysis.toolType))
    }
    return tpl
  }

  if (route.group === 'context') return promptStyle.contextPressure
  if (route.group === 'stuck') return promptStyle.stuck
  return promptStyle.continuation
}

// === buildTypeSuggestion — tool 類型感知建議字串 ===
function buildTypeSuggestion(toolType) {
  switch (toolType) {
    case 'bash': return '改用 write 產生腳本，或拆分為更小指令'
    case 'edit': return '先用 read 確認行號，或改用 write 覆蓋整個檔案'
    case 'write': return '先用 bash mkdir -p 建立目錄，再 write'
    case 'read': return '確認檔案路徑是否正確'
    case 'grep': return '簡化搜尋關鍵字，或改用 read 直接讀取'
    case 'glob': return '簡化 glob pattern，或改用 ls 確認'
    case 'todowrite': return '重送 todowrite 更新任務狀態，確認哪些已完成哪些待辦'
    case 'memory': return '先用 read 確認相關記憶，再決定是否需要新增記憶'
    case 'question': return '直接回答使用者問題，不要猜測'
    case 'search': return '使用更具體的搜尋關鍵字，或改用 web-forager'
    case 'websearch': return '改用 exa_web_search_exa 搜尋更精確的關鍵字'
    case 'web-forager': return '改用 jina_fetch 直接讀取目標網頁'
    case 'exa_web_search_exa': return '更換搜尋詞，或改用 exa_crawling_exa 直接爬取'
    default: return `改用完全不同工具處理 ${toolType}`
  }
}

// === Task 3.11: fillTemplate ===
function fillTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, key) => vars[key] !== undefined ? vars[key] : `{${key}}`)
}

// === buildInjectPrompt — 最終 prompt 生成入口 ===
function buildInjectPrompt(state, todos, config) {
  const promptType = determinePromptType(state, todos, config)
  const promptStyle = getPromptStyle(config)
  const errorLevel = state.toolErrorAnalysis?.level || 0
  const template = selectPromptTemplate(promptType, promptStyle, errorLevel, state, todos)

  const prompt = fillTemplate(template, {
    task: todos.find(t => t.status === 'in_progress')?.content || (todos[0]?.content || ''),
    n: todos.filter(t => t.status !== 'completed').length,
    lastTool: state.toolErrorAnalysis?.lastErrorTool || '',
    suggestion: '',
  })
  return { prompt: `${prompt}\n\n請使用台灣繁體中文回答。`, promptType }
}

// === Task 3.12: injectContinuation ===
async function injectContinuation(sessionID, state, todos, client, config) {
  const { prompt, promptType } = buildInjectPrompt(state, todos, config)
  if (!prompt) {
    const logger = getLogger()
    logger.warn(`[INJECT] empty prompt for ${sessionID}, skip`)
    return
  }

  state.lastInjectionTime = Date.now()
  state.processingGuard = true

  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: 'text', text: prompt }] },
    })
    const logger = getLogger()
    logger.log(`[OK] [${sessionID}] injected: ${promptType}`)
  } catch (e) {
    const logger = getLogger()
    logger.err(`[INJECT] prompt failed for ${sessionID}: ${e.message}`)
  }
}

module.exports = {
  determinePromptType,
  selectPromptTemplate,
  buildInjectPrompt,
  injectContinuation,
  buildTypeSuggestion,
  fillTemplate,
  INJECTOR_ROUTES,
}
