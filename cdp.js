/**
 * dsh-element-picker — CDP bridge.
 *
 * Browser windows do not expose their DOM to UI Automation, so a point pick inside
 * Edge/Chrome can only resolve the window. When the browser was started with
 * `--remote-debugging-port=…`, this module injects a small picker agent into the
 * matching tab instead: the page highlights the element under the pointer, the click
 * comes back over the DevTools protocol, and the result has a real CSS selector,
 * page URL and text — the same shape as an in-app pick.
 *
 * The WebSocket client is hand-rolled so the plugin has no runtime dependency on
 * `ws`, which the host process may not resolve from this package.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

const PORTS = [9222, 9223, 9224, 9333]
const TIMEOUT_MS = 90_000

/** The in-page agent: outline the hovered element, send one pick on click. */
const AGENT_SOURCE = `(function () {
  if (window.__dshCdpPicker) return 'already'
  window.__dshCdpPicker = true

  var box = document.createElement('div')
  box.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;' +
    'border:2px solid #4c8dff;background:rgba(76,141,255,0.16);border-radius:2px;display:none'
  var tip = document.createElement('div')
  tip.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;display:none;' +
    'font:12px/1.5 system-ui,sans-serif;color:#fff;background:rgba(18,26,40,.92);padding:2px 6px;border-radius:4px'
  function mount() {
    if (!box.parentNode) document.documentElement.appendChild(box)
    if (!tip.parentNode) document.documentElement.appendChild(tip)
  }

  function classes(el) {
    var out = []
    for (var i = 0; i < el.classList.length; i += 1) {
      var name = el.classList[i]
      if (!/^[A-Za-z0-9]{4,8}_/.test(name) && name.indexOf('__') === -1) out.push(name)
    }
    return out.slice(0, 2)
  }

  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return ''
    try { if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id) } catch (e) {}
    var path = []
    var cur = el
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var seg = cur.tagName.toLowerCase()
      if (cur.id) {
        try { if (document.querySelectorAll('#' + CSS.escape(cur.id)).length === 1) { path.unshift('#' + CSS.escape(cur.id)); break } } catch (e) {}
      }
      var cs = classes(cur)
      for (var i = 0; i < cs.length; i += 1) seg += '.' + CSS.escape(cs[i])
      var parent = cur.parentElement
      if (parent) {
        var same = []
        for (var j = 0; j < parent.children.length; j += 1) if (parent.children[j].tagName === cur.tagName) same.push(parent.children[j])
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')'
      }
      path.unshift(seg)
      try { if (document.querySelectorAll(path.join(' > ')).length === 1) break } catch (e) {}
      cur = cur.parentElement
    }
    return path.join(' > ')
  }

  function describe(el) {
    var rect = el.getBoundingClientRect()
    var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160)
    var label = el.tagName.toLowerCase()
    if (el.id) label += '#' + el.id
    var cs = classes(el)
    if (cs.length) label += '.' + cs[0]
    if (text) label += ' · ' + text.slice(0, 40)
    return {
      label: label,
      selector: selectorOf(el),
      text: text,
      tag: el.tagName.toLowerCase(),
      page: location.href,
      title: document.title,
      rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
    }
  }

  function onMove(event) {
    var el = event.target
    if (!el || el.nodeType !== 1 || el === box || el === tip) return
    mount()
    var rect = el.getBoundingClientRect()
    box.style.display = 'block'
    box.style.left = rect.left + 'px'
    box.style.top = rect.top + 'px'
    box.style.width = rect.width + 'px'
    box.style.height = rect.height + 'px'
    tip.textContent = describe(el).label
    tip.style.display = 'block'
    tip.style.left = Math.max(0, rect.left) + 'px'
    tip.style.top = Math.max(0, rect.top - 20) + 'px'
  }

  function stop() {
    removeEventListener('mousemove', onMove, true)
    removeEventListener('click', onClick, true)
    removeEventListener('keydown', onKey, true)
    if (box.parentNode) box.parentNode.removeChild(box)
    if (tip.parentNode) tip.parentNode.removeChild(tip)
    window.__dshCdpPicker = false
  }

  function onClick(event) {
    event.preventDefault()
    event.stopPropagation()
    var el = event.target
    var result = el && el.nodeType === 1 ? describe(el) : null
    stop()
    if (result) {
      try { window.__dshPick(JSON.stringify(result)) } catch (e) {}
    }
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      stop()
      try { window.__dshPick(JSON.stringify({ cancelled: true })) } catch (e) {}
    }
  }

  addEventListener('mousemove', onMove, true)
  addEventListener('click', onClick, true)
  addEventListener('keydown', onKey, true)
  return 'armed'
})()`

/** Minimal RFC6455 text client: enough for the DevTools protocol. */
function openSocket(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const key = randomBytes(16).toString('base64')
    const expected = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')

    const req = request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    })

    req.on('upgrade', (response, socket, head) => {
      if (response.headers['sec-websocket-accept'] !== expected) {
        socket.destroy()
        reject(new Error('bad websocket handshake'))
        return
      }
      const listeners = []
      const deliver = (data) => {
        for (const listener of listeners) listener(data)
      }

      const encode = (text) => {
        const payload = Buffer.from(text, 'utf8')
        const mask = randomBytes(4)
        const length = payload.length
        let header
        if (length < 126) {
          header = Buffer.alloc(2)
          header[1] = 0x80 | length
        } else if (length < 65536) {
          header = Buffer.alloc(4)
          header[1] = 0x80 | 126
          header.writeUInt16BE(length, 2)
        } else {
          header = Buffer.alloc(10)
          header[1] = 0x80 | 127
          header.writeBigUInt64BE(BigInt(length), 2)
        }
        header[0] = 0x81
        const masked = Buffer.alloc(length)
        for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i & 3]
        return Buffer.concat([header, mask, masked])
      }

      let buffer = Buffer.alloc(0)
      const consume = (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          if (buffer.length < 2) return
          const opcode = buffer[0] & 0x0f
          const masked = (buffer[1] & 0x80) !== 0
          let length = buffer[1] & 0x7f
          let offset = 2
          if (length === 126) {
            if (buffer.length < 4) return
            length = buffer.readUInt16BE(2)
            offset = 4
          } else if (length === 127) {
            if (buffer.length < 10) return
            length = Number(buffer.readBigUInt64BE(2))
            offset = 10
          }
          const maskOffset = offset
          if (masked) offset += 4
          if (buffer.length < offset + length) return
          let payload = buffer.subarray(offset, offset + length)
          if (masked) {
            const mask = buffer.subarray(maskOffset, maskOffset + 4)
            payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index & 3]))
          }
          buffer = buffer.subarray(offset + length)

          if (opcode === 0x8) {
            socket.destroy()
            return
          }
          if (opcode === 0x9) {
            socket.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0]))
            continue
          }
          if (opcode === 0x1) deliver(payload.toString('utf8'))
        }
      }

      socket.on('data', consume)
      if (head && head.length > 0) consume(head)

      resolve({
        send(value) {
          socket.write(encode(JSON.stringify(value)))
        },
        onmessage(listener) {
          listeners.push(listener)
        },
        close() {
          try {
            socket.destroy()
          } catch (error) {
            /* already closed */
          }
        },
      })
    })

    req.on('error', reject)
    req.setTimeout(4000, () => {
      req.destroy(new Error('websocket timeout'))
    })
    req.end()
  })
}

function httpJson(url, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = request(url, { method: 'GET' }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve(null)
    })
    req.end()
  })
}

/** Which local port answers as a DevTools endpoint, if any. */
export async function findDebugPort(ports = PORTS) {
  for (const port of ports) {
    const version = await httpJson(`http://127.0.0.1:${port}/json/version`)
    if (version && typeof version.webSocketDebuggerUrl === 'string') {
      return { port, version }
    }
  }
  return null
}

export async function listTargets(port) {
  const targets = await httpJson(`http://127.0.0.1:${port}/json/list`, 2000)
  return Array.isArray(targets) ? targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl) : []
}

/** Pick the page whose title best matches the browser window title. */
export function chooseTarget(targets, windowTitle) {
  if (targets.length === 0) return null
  if (!windowTitle) return targets[0]
  const clean = windowTitle.toLowerCase()
  let best = null
  let bestScore = 0
  for (const target of targets) {
    const title = String(target.title || '').toLowerCase()
    if (title === '') continue
    const score = title.length > 2 && clean.includes(title) ? title.length : 0
    if (score > bestScore) {
      bestScore = score
      best = target
    }
  }
  return best ?? targets[0]
}

/**
 * Inject the picker into one tab and wait for the user's click.
 * @param {{windowTitle?: string, port?: number}} options
 * @returns {Promise<{ok: true, pick: object} | {ok: false, reason: string, detail?: string}>}
 */
export async function pickInBrowser(options = {}) {
  const found = options.port ? { port: options.port } : await findDebugPort()
  if (found === null) return { ok: false, reason: 'no-debug-port' }

  const targets = await listTargets(found.port)
  if (targets.length === 0) return { ok: false, reason: 'no-target' }
  const target = chooseTarget(targets, options.windowTitle)
  if (target === null) return { ok: false, reason: 'no-target' }

  let socket
  try {
    socket = await openSocket(target.webSocketDebuggerUrl)
  } catch (error) {
    return { ok: false, reason: 'connect-failed', detail: String(error).slice(0, 200) }
  }

  let nextId = 1
  const pending = new Map()
  let settle
  const picked = new Promise((resolve) => {
    settle = resolve
  })

  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      socket.send({ id, method, params })
    })

  socket.onmessage((text) => {
    let message
    try {
      message = JSON.parse(text)
    } catch (error) {
      return
    }
    if (typeof message.id === 'number' && pending.has(message.id)) {
      pending.get(message.id)(message.result ?? {})
      pending.delete(message.id)
      return
    }
    if (message.method === 'Runtime.bindingCalled' && message.params?.name === '__dshPick') {
      try {
        settle(JSON.parse(String(message.params.payload || '{}')))
      } catch (error) {
        settle({ cancelled: true })
      }
    }
  })

  const timer = setTimeout(() => settle({ cancelled: true }), TIMEOUT_MS)
  try {
    await call('Runtime.enable')
    await call('Runtime.addBinding', { name: '__dshPick' })
    const armed = await call('Runtime.evaluate', { expression: AGENT_SOURCE, awaitPromise: false })
    if (armed?.exceptionDetails) {
      return { ok: false, reason: 'inject-failed', detail: String(armed.exceptionDetails.text || '').slice(0, 200) }
    }
    const result = await picked
    clearTimeout(timer)
    if (result === null || result.cancelled === true) return { ok: false, reason: 'cancelled' }
    return { ok: true, pick: { ...result, port: found.port, targetId: target.id } }
  } finally {
    clearTimeout(timer)
    try {
      await call('Runtime.evaluate', { expression: 'window.__dshCdpPicker && window.__dshCdpPicker === true ? 0 : 0' })
    } catch (error) {
      /* best effort */
    }
    socket.close()
  }
}
