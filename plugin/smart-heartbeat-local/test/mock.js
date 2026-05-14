// mock.js — 測試基礎設施
// 所有 Phase 測試共用的 mock 物件與 fake timers

module.exports = {
  // mockOpencode: 模仿 opencode 全域物件
  mockOpencode: {
    showToast: (msg, type) => { /* no-op */ },
    session: { model: 'gemma-4-4b' },
  },

  // mockClient: 模仿 client API
  mockClient: {
    _handlers: {},
    handlerCount: 0,
    on(event, handler) {
      this._handlers[event] = handler
      this.handlerCount++
      return { off: () => { delete this._handlers[event] } }
    },
    session: {
      async prompt({ message, sessionID }) { /* no-op */ },
      async getTodos() { return [] },
    },
  },

  // mockEvent: 產生活動 payload
  mockEvent(type, overrides = {}) {
    const base = { sessionID: 'test-ses' }
    if (type === 'tool.started') return { properties: { ...base, name: 'edit', ...overrides } }
    if (type === 'tool.completed') return { properties: { ...base, ...overrides } }
    if (type === 'tool.error') return { properties: { ...base, name: 'bash', ...overrides } }
    if (type === 'message.completed') return { info: { ...base, role: 'user', ...overrides } }
    return { ...base, ...overrides }
  },

  // fakeTimers: 自製 timer queue，不依賴真實 setTimeout
  fakeTimers: {
    _originalSetTimeout: null,
    _originalDateNow: null,
    _queue: [],
    _nextId: 1,
    _currentTime: 0,
    _installed: false,

    install() {
      if (this._installed) return
      this._installed = true
      this._originalSetTimeout = global.setTimeout
      this._originalDateNow = global.Date.now
      this._queue = []
      this._nextId = 1
      this._currentTime = Date.now()

      global.setTimeout = (fn, delay, ...args) => {
        const id = this._nextId++
        const fireAt = this._currentTime + (delay || 0)
        this._queue.push({ id, fireAt, fn: () => fn(...args) })
        return id
      }

      global.Date.now = () => this._currentTime
    },

    advanceTime(ms) {
      if (!this._installed) return
      this._currentTime += ms

      const ready = this._queue
        .filter(t => t.fireAt <= this._currentTime)
        .sort((a, b) => a.fireAt - b.fireAt)

      this._queue = this._queue.filter(t => t.fireAt > this._currentTime)

      for (const t of ready) {
        try { t.fn() } catch (e) { console.error('[FAKE_TIMER] callback error:', e) }
      }
    },

    restore() {
      if (!this._installed) return
      this._installed = false
      global.setTimeout = this._originalSetTimeout
      global.Date.now = this._originalDateNow
      this._queue = []
    },
  },
}
