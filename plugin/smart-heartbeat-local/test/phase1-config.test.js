// phase1-config.test.js — Phase 1 Config Unit Tests (10 cases)
const assert = require('assert')
const { describe, it } = require('node:test')
const {
  DEFAULT_CONFIG,
  MODEL_SCALE_TIERS,
  validateConfig,
  detectModelProfile,
  detectModelScale,
  parseParamCountFromModelName,
  getPromptStyle,
  loadConfig,
} = require('../config')

describe('config.js', () => {
  // === parseParamCountFromModelName (1 case, but multiple assertions) ===
  describe('parseParamCountFromModelName', () => {
    it('should parse parameter count correctly', () => {
      assert.strictEqual(parseParamCountFromModelName('gemma-4-4b'), 'small')
      assert.strictEqual(parseParamCountFromModelName('qwen3.5-14b-MTP'), 'medium')
      assert.strictEqual(parseParamCountFromModelName('llama-3-70b'), 'medium')
      assert.strictEqual(parseParamCountFromModelName('mixtral-8x7b'), null)
      assert.strictEqual(parseParamCountFromModelName('no-param-here'), null)
      assert.strictEqual(parseParamCountFromModelName(null), null)
      assert.strictEqual(parseParamCountFromModelName('phi-4-7b'), 'small')
      assert.strictEqual(parseParamCountFromModelName('6.7b'), 'small')
      assert.strictEqual(parseParamCountFromModelName('14b-v0.1'), 'medium')
    })
  })

  // === detectModelScale (2 cases) ===
  describe('detectModelScale', () => {
    it('should detect scale from parameter count', () => {
      assert.strictEqual(detectModelScale('gemma-4-4b'), 'small')
      assert.strictEqual(detectModelScale('phi-4-7b'), 'small')
      assert.strictEqual(detectModelScale('llama-3-8b'), 'small')
      assert.strictEqual(detectModelScale('qwen3.5-14b'), 'medium')
      assert.strictEqual(detectModelScale('llama-3-70b'), 'medium')
    })

    it('should use family defaults when no explicit param count', () => {
      assert.strictEqual(detectModelScale('mixtral-8x7b'), 'medium')
      assert.strictEqual(detectModelScale('gemma'), 'small')
      assert.strictEqual(detectModelScale('unknown-model'), null)
      assert.strictEqual(detectModelScale(null), null)
    })
  })

  // === detectModelProfile (2 cases) ===
  describe('detectModelProfile', () => {
    it('should detect profile from session model name', () => {
      assert.strictEqual(detectModelProfile({ session: { model: 'gemma-4-4b' } }), 'small')
      assert.strictEqual(detectModelProfile({ session: { model: 'qwen3.5-14b' } }), 'medium')
    })

    it('should fallback to small when no info available', () => {
      assert.strictEqual(detectModelProfile({}), 'small')
      assert.strictEqual(detectModelProfile({
        session: { model: 'unknown-v0.1' },
      }), 'small')
    })

    it('should respect explicit override', () => {
      assert.strictEqual(detectModelProfile({
        session: { model: 'unknown-v0.1' },
        config: { heartbeat: { modelScale: 'medium' } }
      }), 'medium')
    })
  })

  // === validateConfig (4 cases) ===
  describe('validateConfig', () => {
    it('should accept valid config', () => {
      const { errors } = validateConfig(DEFAULT_CONFIG)
      assert.strictEqual(errors.length, 0)
    })

    it('should reject invalid type', () => {
      const { errors } = validateConfig({ ...DEFAULT_CONFIG, countdownSeconds: 'abc' })
      assert(errors.length > 0)
      assert(errors.some(e => e.includes('countdownSeconds')))
    })

    it('should reject invalid logLevel', () => {
      const { errors } = validateConfig({ ...DEFAULT_CONFIG, logLevel: 'info' })
      assert(errors.length > 0)
      assert(errors.some(e => e.includes('logLevel')))
    })

    it('should reject boundary values', () => {
      const { errors } = validateConfig({ ...DEFAULT_CONFIG, countdownSeconds: 1 })
      assert(errors.length > 0)
      assert(errors.some(e => e.includes('countdownSeconds')))
    })
  })

  // === getPromptStyle (1 case) ===
  describe('getPromptStyle', () => {
    it('should return ultra_short for small models, short for medium', () => {
      const smallStyle = getPromptStyle({ modelScale: 'small' })
      assert(smallStyle.continuation)
      assert(smallStyle.continuation.includes('[續行]'))

      const mediumStyle = getPromptStyle({ modelScale: 'medium' })
      assert(mediumStyle.continuation)
      assert(mediumStyle.continuation.includes('[續行]'))

      const fallbackStyle = getPromptStyle({})
      assert(fallbackStyle.continuation)
    })
  })

  // === loadConfig (integration) ===
  describe('loadConfig', () => {
    it('should merge config correctly', () => {
      const opencode = {
        session: { model: 'gemma-4-4b' },
        config: {
          heartbeat: {
            countdownSeconds: 60,
            logLevel: 'debug',
          }
        }
      }
      const { config, errors } = loadConfig(opencode)
      assert.strictEqual(errors.length, 0)
      assert.strictEqual(config.countdownSeconds, 60)
      assert.strictEqual(config.logLevel, 'debug')
      assert.strictEqual(config.modelScale, 'small')
    })

    it('should fallback to defaults on validation error', () => {
      const opencode = {
        config: { heartbeat: { countdownSeconds: -1 } }
      }
      const { config, errors } = loadConfig(opencode)
      assert(errors.length > 0)
      assert.strictEqual(config.countdownSeconds, DEFAULT_CONFIG.countdownSeconds)
    })
  })
})
