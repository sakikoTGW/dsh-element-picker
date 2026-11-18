/**
 * Companion extension: the bridge between this browser and the DSH plugin.
 *
 * The plugin cannot open a debugging port on a browser the user already runs, so
 * this extension asks the plugin's loopback server whether a pick session is armed,
 * injects the page kernel into the active tab for that session only, and posts the
 * result back. No debug port, no relaunch, logins stay put.
 */

const HOST = 'http://127.0.0.1' // port comes from the user's config; see PORT below
let PORT = 45917
const POLL_ARMED = 400
const POLL_IDLE = 2000
const AGENT_FILE = 'agent.js'

const state = { armed: false, token: '', tabId: 0, timer: 0, busy: false }

async function hostJson(path, init) {
  const response = await fetch(HOST + ':' + PORT + path, { cache: 'no-store', ...init })
  if (!response.ok) throw new Error('host ' + response.status)
  return response.json()
}

async function fetchAgent() {
  const response = await fetch(HOST + ':' + PORT + '/agent.js', { cache: 'no-store' })
  if (!response.ok) throw new Error('agent ' + response.status)
  return response.text()
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab && typeof tab.id === 'number' ? tab : null
}

async function inject(tabId, token) {
  const source = await fetchAgent()
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    args: [source, token],
    func: (code, sessionToken) => {
      // Isolated world: page CSP does not apply and chrome.runtime is available.
      const existing = window.__dshRefAgent
      if (existing && existing.build === sessionToken) return
      if (existing && typeof existing.stop === 'function') existing.stop()
      try {
        // eslint-disable-next-line no-new-func
        new Function(code)()
      } catch (error) {
        window.__dshRefAgent = null
      }
    },
  })
}

async function stopAgent(tabId) {
  if (!tabId) return
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        if (window.__dshRefAgent && typeof window.__dshRefAgent.stop === 'function') window.__dshRefAgent.stop()
        window.__dshRefAgent = null
      },
    })
  } catch (error) {
    /* tab closed */
  }
}

async function postPick(payload) {
  await hostJson('/pick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: state.token, payload }),
  })
}

async function tick() {
  if (state.busy) return
  state.busy = true
  try {
    const info = await hostJson('/state')
    PORT = Number(info.port) > 0 ? Number(info.port) : PORT
    if (info.armed === true && typeof info.token === 'string' && info.token !== '') {
      state.armed = true
      state.token = info.token
      const tab = await activeTab()
      if (tab !== null && tab.id !== state.tabId) {
        state.tabId = tab.id
        await inject(tab.id, info.token)
      }
    } else if (state.armed) {
      state.armed = false
      state.token = ''
      await stopAgent(state.tabId)
      state.tabId = 0
    }
  } catch (error) {
    if (state.armed) {
      state.armed = false
      state.token = ''
      await stopAgent(state.tabId)
      state.tabId = 0
    }
  } finally {
    state.busy = false
    state.timer = setTimeout(tick, state.armed ? POLL_ARMED : POLL_IDLE)
    chrome.alarms.create('dsh-ref-poll', { delayInMinutes: 0.5 })
  }
}

// The kernel reports through this channel; only our own injected frame may post.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message === null || typeof message !== 'object') return false
  if (message.type === 'dsh-ref-pick') {
    postPick(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message) }))
    return true
  }
  if (message.type === 'dsh-ref-cancel') {
    stopAgent(sender.tab ? sender.tab.id : state.tabId)
    sendResponse({ ok: true })
    return false
  }
  if (message.type === 'dsh-ref-alive') {
    sendResponse({ ok: true })
    return false
  }
  return false
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dsh-ref-poll' && state.timer === 0) {
    state.timer = 0
    tick()
  }
})

chrome.tabs.onActivated.addListener(() => {
  if (state.armed && state.tabId !== 0) {
    stopAgent(state.tabId)
    state.tabId = 0
  }
})

chrome.runtime.onStartup.addListener(() => {
  if (state.timer === 0) tick()
})

chrome.runtime.onInstalled.addListener(() => {
  if (state.timer === 0) tick()
})

if (state.timer === 0) tick()

export { AGENT_FILE }
