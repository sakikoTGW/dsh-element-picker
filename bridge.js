/**
 * Companion-browser bridge.
 *
 * A browser the user already runs cannot be given a debugging port, so a small
 * companion extension is the only way in: it asks this loopback server whether a
 * pick session is armed, injects the page kernel into the active tab for the
 * duration of the session, and posts the pick back.
 *
 * Security:
 *   - binds 127.0.0.1 only
 *   - a fresh token per armed session; /pick refuses anything else
 *   - browser pages get no CORS grant: only `chrome-extension://` origins are allowed
 *   - the kernel source served is this package's extension/agent.js verbatim
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const MAX_BODY = 256 * 1024

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) return null
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    return null
  }
}

/**
 * @param {object} options
 * @param {number} options.port
 * @param {() => string} options.agentSource
 * @param {(payload: object) => void} options.onPick
 * @param {() => boolean} options.isArmed
 */
export function createBridge(options) {
  const session = { token: '', armed: false, lastPollAt: 0, lastPickAt: 0, connected: false }
  let server = null
  let port = 0

  function grant(res, req) {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin.startsWith('chrome-extension://')) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
    }
  }

  function handler(req, res) {
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: 'loopback-only' })
      return
    }
    grant(res, req)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    if (path === '/state' && req.method === 'GET') {
      session.lastPollAt = Date.now()
      session.connected = true
      sendJson(res, 200, {
        armed: session.armed,
        token: session.armed ? session.token : '',
        agent: session.armed ? '/agent.js' : '',
        build: options.build ?? '',
      })
      return
    }

    if (path === '/agent.js' && req.method === 'GET') {
      const source = options.agentSource()
      if (typeof source !== 'string' || source === '') {
        sendJson(res, 503, { error: 'agent-missing' })
        return
      }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(source)
      return
    }

    if (path === '/pick' && req.method === 'POST') {
      readJson(req).then((body) => {
        const token = body && typeof body.token === 'string' ? body.token : ''
        if (!session.armed || token === '' || token !== session.token) {
          sendJson(res, 403, { ok: false, error: 'not-armed' })
          return
        }
        const payload = body && body.payload
        if (payload === null || typeof payload !== 'object') {
          sendJson(res, 400, { ok: false, error: 'bad-payload' })
          return
        }
        session.lastPickAt = Date.now()
        session.connected = true
        try {
          options.onPick({ ...payload, provider: 'extension' })
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error && error.message) })
        }
      })
      return
    }

    sendJson(res, 404, { error: 'not-found' })
  }

  return {
    start() {
      if (server !== null) return
      server = createServer(handler)
      server.on('error', () => {
        server = null
      })
      server.listen(options.port, '127.0.0.1', () => {
        port = server.address().port
      })
    },
    stop() {
      if (server === null) return
      try {
        server.close()
      } catch (error) {
        /* already closed */
      }
      server = null
      port = 0
    },
    /** A new session token per arm; the extension learns it from /state. */
    arm() {
      session.token = randomBytes(9).toString('hex')
      session.armed = true
      return session.token
    },
    disarm() {
      session.armed = false
      session.token = ''
    },
    status() {
      return {
        running: server !== null,
        port,
        armed: session.armed,
        token: session.armed ? session.token : '',
        connected: session.connected,
        lastPollAt: session.lastPollAt,
        lastPickAt: session.lastPickAt,
      }
    },
  }
}
