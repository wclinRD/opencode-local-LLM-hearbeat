// config.js — Smart Heartbeat Local LLM Plugin Config
// 設定 schema + 驗證 + model profiles (small/medium)
//
// Exports:
//   DEFAULT_CONFIG, MODEL_SCALE_TIERS,
//   loadConfig(opencode), validateConfig(raw),
//   detectModelProfile(opencode), detectModelScale(modelName),
//   parseParamCountFromModelName(modelName), getPromptStyle(config)

// === Task 1.1: 23 個參數的預設值 ===
const DEFAULT_CONFIG = {
  modelScale: 'auto',           // 'auto' | 'small' | 'medium'
  countdownSeconds: 30,
  minIntervalMs: 90000,
  maxStuckCycles: 8,
  maxToolErrors: 8,
  maxRepeatedTool: 10,
  maxIdleSeconds: 120,
  promptSpeedTps: 50,
  maxRecoveryAttempts: 3,
  recoveryVerificationMaxMs: 60000,
  deathSpiralWindowMs: 300000,
  deathSpiralThreshold: 3,
  logLevel: 'warn',
  effectiveMaxContext: 32000,
  toolTimeout: { task: 300, bash: 120, edit: 60, read: 30, default: 60 },
  persistence: { maxFiles: 100, cleanupAgeHours: 24, debounceMs: 5000 },
}

// === Task 1.2: Model Scale Tiers — 2 級設定 ===
const MODEL_SCALE_TIERS = {
  'small': {    // < 10B params
    promptSpeedTps: 50, effectiveMaxContext: 32000,
    countdownSeconds: 30, minIntervalMs: 90000,
    maxStuckCycles: 8, maxToolErrors: 8, maxRepeatedTool: 10,
    maxIdleSeconds: 120, maxRecoveryAttempts: 3,
    recoveryVerificationMaxMs: 60000, deathSpiralThreshold: 3,
    promptStyle: 'ultra_short',
  },
  'medium': {   // >= 10B params
    promptSpeedTps: 120, effectiveMaxContext: 64000,
    countdownSeconds: 20, minIntervalMs: 60000,
    maxStuckCycles: 5, maxToolErrors: 5, maxRepeatedTool: 8,
    maxIdleSeconds: 90, maxRecoveryAttempts: 2,
    recoveryVerificationMaxMs: 45000, deathSpiralThreshold: 4,
    promptStyle: 'short',
  },
}

// === Task 1.2: parseParamCountFromModelName ===
function parseParamCountFromModelName(modelName) {
  if (typeof modelName !== 'string') return null
  // 跳過 MoE 模式 "8x7b" ("digit+x+digit+b")
  if (/\d+x\d+\s*b/i.test(modelName)) return null
  const match = modelName.match(/(\d+\.?\d*)\s*b/i)
  if (!match) return null
  const count = parseFloat(match[1])
  return (count < 10) ? 'small' : 'medium'
}

// === Task 1.2: detectModelScale ===
function detectModelScale(modelName) {
  if (typeof modelName !== 'string') return null

  // Priority 1: 正則解析參數數值
  const fromParam = parseParamCountFromModelName(modelName)
  if (fromParam) return fromParam

  // Priority 2: 已知模型家族預設值
  const lower = modelName.toLowerCase()
  if (lower.includes('gemma') || lower.includes('phi')) return 'small'
  if (lower.includes('llama')
    || lower.includes('mistral')
    || lower.includes('mixtral')
    || lower.includes('deepseek')
    || lower.includes('qwen')
    || lower.includes('yi')) return 'medium'

  return null
}

// === Task 1.2: detectModelProfile ===
function detectModelProfile(opencode) {
  // 若有顯式設定且非 auto，直接採用
  const explicitScale = opencode?.config?.heartbeat?.modelScale
  if (explicitScale && explicitScale !== 'auto') {
    if (MODEL_SCALE_TIERS[explicitScale]) return explicitScale
  }

  // 自動偵測：從 session model name
  const modelName = opencode?.session?.model
    || opencode?.config?.model
    || process.env.OPENCODE_MODEL
  if (modelName) {
    const matched = detectModelScale(String(modelName))
    if (matched && MODEL_SCALE_TIERS[matched]) return matched
  }

  // Fallback: 最保守設定 (small)
  return 'small'
}

// === Task 1.4: validateConfig ===
function validateConfig(config) {
  const errors = []

  // Type check: 所有數值欄位必須是 number 且 >= 0
  const numFields = [
    'countdownSeconds', 'minIntervalMs', 'maxStuckCycles', 'maxToolErrors',
    'maxRepeatedTool', 'maxIdleSeconds', 'promptSpeedTps', 'maxRecoveryAttempts',
    'recoveryVerificationMaxMs', 'deathSpiralWindowMs', 'deathSpiralThreshold',
    'effectiveMaxContext',
  ]
  for (const field of numFields) {
    const val = config[field]
    if (val !== undefined && (typeof val !== 'number' || isNaN(val) || val < 0)) {
      errors.push(`${field}: must be positive number, got ${typeof val}`)
    }
  }

  // Range checks
  if (config.countdownSeconds < 5) errors.push('countdownSeconds too low (<5)')
  if (config.maxRecoveryAttempts < 1) errors.push('maxRecoveryAttempts too low (<1)')
  if (config.deathSpiralThreshold < 1) errors.push('deathSpiralThreshold too low (<1)')

  // logLevel enum
  if (!['debug', 'warn', 'err'].includes(config.logLevel)) {
    errors.push(`invalid logLevel: ${config.logLevel}, must be debug|warn|err`)
  }

  // toolTimeout validation
  if (config.toolTimeout && typeof config.toolTimeout === 'object') {
    for (const [key, val] of Object.entries(config.toolTimeout)) {
      if (typeof val !== 'number' || val < 0) {
        errors.push(`toolTimeout.${key}: must be positive number`)
      }
    }
  }

  return { errors, config }
}

// === Task 1.3: loadConfig ===
function loadConfig(opencode) {
  const raw = opencode?.config?.heartbeat || {}

  // Detect scale (auto or explicit)
  const detectedOrExplicit = detectModelProfile(opencode)
  const scaleConfig = MODEL_SCALE_TIERS[detectedOrExplicit] || MODEL_SCALE_TIERS['small']

  // raw.profiles 的 key 必須是 scale tier 名稱 ('small'|'medium')
  const customProfile = raw.profiles?.[detectedOrExplicit] || {}

  // Merge: default ← scale tier ← custom profile ← explicit override
  const merged = deepMerge(DEFAULT_CONFIG, scaleConfig, customProfile, raw)
  delete merged.profiles

  // Store resolved scale for getPromptStyle
  merged.modelScale = detectedOrExplicit

  // Apply scale-tier overrides that weren't in raw
  // effectiveMaxContext, promptSpeedTps already merged via scaleConfig

  const { errors } = validateConfig(merged)
  if (errors.length > 0) {
    return { config: { ...DEFAULT_CONFIG, modelScale: 'small' }, errors }
  }
  return { config: merged, errors: [] }
}

// === Task 1.5: PROMPT_STYLES — 2 種風格 ===
const PROMPT_STYLES = {
  ultra_short: {
    continuation: '[續行] 還有 {n} 項。下一項：{task} 直接執行。完成用 todowrite。不要問。',
    toolErrorL1: '[續行] tool 失敗。重試 {task}。直接執行。',
    toolErrorL2: '[續行] tool 失敗 {n} 次。換方法做 {task}。直接執行。',
    toolErrorL3: '[續行] tool 一直失敗。用全新方法。不要用 {lastTool}。直接執行。',
    toolErrorL4: '[續行] tool 一直失敗。用 websearch 查解法。不要猜。',
    recoveryL0: '繼續',
    recoveryL1: '繼續任務',
    recoveryL2: '繼續: {task}',
    contextPressure: '[續行] context 壓力大。任務餘 {n}。{task} 直接完成，避免大型輸出。',
    stuck: '[續行] 卡住。換全新方法做 {task}。不要重複。直接執行。',
  },
  short: {
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

function getPromptStyle(config) {
  const scale = config.modelScale || 'small'
  const tier = MODEL_SCALE_TIERS[scale] || MODEL_SCALE_TIERS['small']
  return PROMPT_STYLES[tier?.promptStyle || 'ultra_short'] || PROMPT_STYLES.ultra_short
}

// deepMerge (inline 因為 config.js 不能依賴 utils.js)
function deepMerge(...objects) {
  const result = {}
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue
    for (const key of Object.keys(obj)) {
      if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
        result[key] = deepMerge(result[key] || {}, obj[key])
      } else {
        result[key] = obj[key]
      }
    }
  }
  return result
}

module.exports = {
  DEFAULT_CONFIG,
  MODEL_SCALE_TIERS,
  loadConfig,
  validateConfig,
  detectModelProfile,
  detectModelScale,
  parseParamCountFromModelName,
  getPromptStyle,
  PROMPT_STYLES,
}
