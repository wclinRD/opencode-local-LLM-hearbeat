// verify-api.js — API 行為驗證 script (雙模態: standalone + plugin)
// 執行方式:
//   node .opencode/plugins/smart-heartbeat-local/verify-api.js
// 或在 opencode.json 加入 plugins: ["verify-api"] 載入
//
// 驗證 5 項未知 API 行為:
// 1. client.session.prompt 模式 (APPEND / REPLACE / INJECT)
// 2. tool.started payload key 結構
// 3. tool.completed payload key 結構
// 4. opencode.showToast 是否存在
// 5. todo 讀取 API: client.session.getTodos() / opencode.session.todos

// === Standalone 模式：內建 mock OpenCode API ===
const MOCK = {
  promptMode: null,
  events: {},
  showToast: false,
  modelName: 'gemma-4-4b',
  todoAPI: null,
}

async function runVerifyStandalone() {
  console.log('[API-VERIFY] ====== API 行為驗證 (Standalone Mode) ======\n')

  // 1. Prompt 模式驗證
  MOCK.promptMode = 'APPEND (預期，需在 OpenCode log 中手動確認 context 內容)'
  console.log('[1/5] client.session.prompt 模式:')
  console.log(`      預期: APPEND (多次 prompt 呼叫會疊加 context)`)
  console.log(`      驗證方式: 在 plugin 模式下手動檢查 context 是否有兩條訊息`)
  console.log(`      結果: ${MOCK.promptMode}\n`)

  // 2. Event payload 結構 — tool.started
  MOCK.events['tool.started'] = ['properties.sessionID', 'properties.name']
  console.log('[2/5] tool.started payload key 結構:')
  console.log(`      預期 keys: properties.sessionID, properties.name`)
  console.log(`      結果: ${JSON.stringify(MOCK.events['tool.started'])}\n`)

  // 3. Event payload 結構 — tool.completed
  MOCK.events['tool.completed'] = ['properties.sessionID', 'properties.name']
  MOCK.events['message.completed'] = ['info.role', 'info.sessionID']
  console.log('[3/5] tool.completed / message.completed payload keys:')
  console.log(`      tool.completed: ${JSON.stringify(MOCK.events['tool.completed'])}`)
  console.log(`      message.completed: ${JSON.stringify(MOCK.events['message.completed'])}\n`)

  // 4. showToast
  MOCK.showToast = typeof globalThis.showToast === 'function'
  console.log('[4/5] opencode.showToast:')
  console.log(`      結果: ${MOCK.showToast ? '✅ 存在' : '❌ 不存在 (需改用 console.log/warn)'}\n`)

  // 5. Todo 讀取 API
  MOCK.todoAPI = '需待 OpenCode 文件確認 client.session.getTodos() 是否存在'
  console.log('[5/5] Todo 讀取 API:')
  console.log(`      client.session.getTodos(): 未知 (需在 plugin 模式驗證)`)
  console.log(`      opencode.session.todos: 未知 (需在 plugin 模式驗證)`)
  console.log(`      結果: ${MOCK.todoAPI}\n`)

  console.log('[API-VERIFY] ====== 驗證完成 ======')
  console.log('請在 plugin 模式下手動確認以下項目:')
  console.log('  1. 注入兩次 prompt → 檢查 context 是否都有 (APPEND)')
  console.log('  2. tool.started payload 的實際 key 名稱')
  console.log('  3. tool.completed payload 的實際 key 名稱')
  console.log('  4. opencode.showToast 是否存在')
  console.log('  5. client.session.getTodos() / opencode.session.todos 是否可用')
  console.log()
  console.log('輸出:')
  console.log(JSON.stringify(MOCK, null, 2))
  return MOCK
}

// === Plugin 模式：由 OpenCode 載入 ===
module.exports = {
  onStart: async (opencode, client) => {
    console.log('[API-VERIFY] ====== API 行為驗證 (Plugin Mode) ======\n')

    const results = {
      promptMode: null,
      events: {},
      showToast: false,
      modelName: null,
      todoAPI: null,
    }

    // 1. Prompt 模式 — 注入兩次，手動檢查 context 數量
    console.log('[1/5] 測試 client.session.prompt 模式...')
    try {
      await client.session.prompt({ message: '[API-VERIFY] 第一條測試訊息', sessionID: 'verify' })
      await client.session.prompt({ message: '[API-VERIFY] 第二條測試訊息', sessionID: 'verify' })
      results.promptMode = 'INJECTED (手動檢查 context 是否有兩條訊息)'
      console.log('      已注入兩條訊息，請手動檢查 context')
    } catch (e) {
      results.promptMode = `ERROR: ${e.message}`
      console.log(`      ❌ prompt 失敗: ${e.message}`)
    }

    // 2. Event payload — 監聽 tool.started
    console.log('[2/5] 監聽 tool.started payload...')
    client.on('tool.started', event => {
      results.events['tool.started'] = Object.keys(event)
      console.log(`      tool.started payload keys: ${Object.keys(event).join(', ')}`)
    })

    // 3. Event payload — 監聽 tool.completed
    console.log('[3/5] 監聽 tool.completed payload...')
    client.on('tool.completed', event => {
      results.events['tool.completed'] = Object.keys(event)
      console.log(`      tool.completed payload keys: ${Object.keys(event).join(', ')}`)
    })
    client.on('message.completed', event => {
      results.events['message.completed'] = Object.keys(event)
      console.log(`      message.completed payload keys: ${Object.keys(event).join(', ')}`)
    })

    // 4. showToast
    results.showToast = typeof opencode.showToast === 'function'
    console.log(`[4/5] opencode.showToast: ${results.showToast ? '✅ 存在' : '❌ 不存在'}`)

    // 5. Model name
    results.modelName = opencode?.session?.model || process.env.OPENCODE_MODEL || 'unknown'
    console.log(`[5/5] Model name: ${results.modelName}`)

    // 6. Todo API
    if (typeof client?.session?.getTodos === 'function') {
      results.todoAPI = 'client.session.getTodos() 可用'
    } else if (Array.isArray(opencode?.session?.todos)) {
      results.todoAPI = 'opencode.session.todos 可用'
    } else {
      results.todoAPI = '兩者皆不可用，需使用 persistence fallback'
    }
    console.log(`      Todo API: ${results.todoAPI}`)

    console.log('\n[API-VERIFY] ====== 驗證結果 ======')
    console.log(JSON.stringify(results, null, 2))
    console.log('\n⚠️ 請將此結果記錄到 verify-results.json 或 design doc 中')

    return results
  },
}

// Standalone 直接執行
if (require.main === module) {
  runVerifyStandalone().catch(e => {
    console.error('[API-VERIFY] Fatal error:', e.message)
    process.exit(1)
  })
}
