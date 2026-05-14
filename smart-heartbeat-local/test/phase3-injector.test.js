// phase3-injector.test.js — Injector Unit Tests (13 cases)
const assert = require('assert')
const { describe, it, beforeEach } = require('node:test')
const {
  determinePromptType,
  selectPromptTemplate,
  buildInjectPrompt,
  buildTypeSuggestion,
  fillTemplate,
} = require('../injector')
const { PROMPT_STYLES, DEFAULT_CONFIG } = require('../config')
const { createOrGetState, getStatesMap } = require('../state')

const TEST_CONFIG = { ...DEFAULT_CONFIG, modelScale: 'small' }

describe('injector.js', () => {
  beforeEach(() => {
    getStatesMap().clear()
  })

  // === selectPromptTemplate (7 cases) ===
  describe('selectPromptTemplate', () => {
    const style = PROMPT_STYLES.ultra_short
    const state = { toolCallHistory: [], toolErrorAnalysis: { level: 0, toolType: null } }
    const todos = [{ content: 'task', status: 'in_progress' }]

    it('should handle recovery type', () => {
      const result = selectPromptTemplate('recovery', style, 0, state, todos)
      assert.ok(result)
      assert.strictEqual(result, '繼續')
    })

    it('should handle tool_error type', () => {
      const result = selectPromptTemplate('tool_error', style, 1, state, todos)
      assert.ok(result)
      assert(result.includes('重試'))
    })

    it('should handle tool_error_escalated type', () => {
      const result = selectPromptTemplate('tool_error_escalated', style, 3, state, todos)
      assert.ok(result)
    })

    it('should handle tool_error_search type', () => {
      const result = selectPromptTemplate('tool_error_search', style, 0, state, todos)
      assert.ok(result)
      assert(result.includes('websearch'))
    })

    it('should handle context_pressure type', () => {
      const result = selectPromptTemplate('context_pressure', style, 0, state, todos)
      assert.ok(result)
      assert(result.includes('context'))
    })

    it('should handle stuck type', () => {
      const result = selectPromptTemplate('stuck', style, 0, state, todos)
      assert.ok(result)
      assert(result.includes('卡住'))
    })

    it('should handle normal type', () => {
      const result = selectPromptTemplate('normal', style, 0, state, todos)
      assert.ok(result)
      assert(result.includes('續行'))
    })
  })

  // === determinePromptType (3 cases) ===
  describe('determinePromptType', () => {
    it('should prioritize recovery', () => {
      const state = createOrGetState('test')
      state.recoveryState = 'injected'
      const result = determinePromptType(state, [], TEST_CONFIG)
      assert.strictEqual(result, 'recovery')
    })

    it('should detect tool error', () => {
      const state = createOrGetState('test')
      state.toolCallHistory = [
        { name: 'bash', status: 'error', time: Date.now() - 10000 },
      ]
      const result = determinePromptType(state, [], TEST_CONFIG)
      assert(result === 'tool_error' || result === 'tool_error_escalated')
    })

    it('should return normal for no issues', () => {
      const state = createOrGetState('test')
      const result = determinePromptType(state, [{ content: 'task', status: 'pending' }], TEST_CONFIG)
      assert.strictEqual(result, 'normal')
    })
  })

  // === buildInjectPrompt (3 cases) ===
  describe('buildInjectPrompt', () => {
    it('should build normal continuation prompt', () => {
      const state = createOrGetState('test')
      const todos = [{ content: 'test task', status: 'in_progress' }]
      const result = buildInjectPrompt(state, todos, TEST_CONFIG)
      assert(result.prompt)
      assert(result.promptType)
      assert(result.prompt.length > 0)
    })

    it('should build tool error prompt', () => {
      const state = createOrGetState('test')
      state.toolCallHistory = Array(2).fill({ name: 'bash', status: 'error', time: Date.now() - 10000 })
      const todos = [{ content: 'test task', status: 'in_progress' }]
      const result = buildInjectPrompt(state, todos, TEST_CONFIG)
      assert(result.prompt)
      assert(result.promptType !== 'normal')
    })

    it('should build prompt with empty todos', () => {
      const state = createOrGetState('test')
      const result = buildInjectPrompt(state, [], TEST_CONFIG)
      assert(result.prompt)
      assert(result.prompt.length > 0)
    })
  })

  // === fillTemplate (variable replacement) ===
  describe('fillTemplate', () => {
    it('should replace variables correctly', () => {
      assert.strictEqual(fillTemplate('繼續: {task}', { task: '測試' }), '繼續: 測試')
      assert.strictEqual(fillTemplate('{a}', { a: '1' }), '1')
    })

    it('should keep missing variables unchanged', () => {
      assert.strictEqual(fillTemplate('{missing}', {}), '{missing}')
    })
  })

  // === buildTypeSuggestion ===
  describe('buildTypeSuggestion', () => {
    it('should return tool-type suggestions', () => {
      assert(buildTypeSuggestion('bash').includes('write'))
      assert(buildTypeSuggestion('edit').includes('read'))
      assert(buildTypeSuggestion('write').includes('mkdir'))
      assert(buildTypeSuggestion('unknown').includes('unknown'))
    })
  })
})
