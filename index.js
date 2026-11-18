/**
 * dsh-element-picker — 宿主半边。
 *
 * DSH 之外的元素由 Windows UI Automation 读取：`native/os-pick.ps1` 常驻、监听全局
 * 热键，按下后读取光标下的控件并发到这里；客户端轮询同一份状态，把结果变成引用
 * chip。除此之外宿主只提供这两条回环 HTTP 路由，不注册任何服务。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findDebugPort, listTargets, pickInBrowser } from './cdp.js'
import { createEngine, formatPick, userDirs } from './protocols.js'
import { createBridge } from './bridge.js'

export const name = 'element-picker'
export const inject = ['webServer']

const ROUTE = '/element-picker/os'

/**
 * Only one helper may run: a remount (bundle toggle, HMR) must not leave the
 * previous PowerShell listening for the same hotkey, because two helpers open two
 * overlays and swallow each other's picks.
 */
let liveHelper = null
const MAX_BODY = 64 * 1024
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** @param {import('node:http').ServerResponse} res */
function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('payload too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean, hotkey?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  // Outside-DSH picking is opt-in: the platform ceiling (Chromium exposes only the
  // window without a debug port) made it unreliable, so the default stays in-app only.
  const external = config.external === true
  // How a pick enters the composer: DSH's own quote card first, or our reference chip.
  const referenceStyle = config.referenceStyle === 'quote' ? 'quote' : 'chip'
  // Companion-browser bridge: the only way into a browser the user already runs.
  const extension = config.extension !== false
  const extensionPort = Number.isInteger(config.extensionPort) && config.extensionPort > 1024 && config.extensionPort < 65536
    ? config.extensionPort
    : 45917
  const textDetail = ['compact', 'standard', 'full'].includes(config.textDetail) ? config.textDetail : 'standard'
  const hotkey = typeof config.hotkey === 'string' && config.hotkey !== '' ? config.hotkey : 'Ctrl+Alt+P'
  const language = config.language === 'en' ? 'en' : 'zh'

  /**
   * The revision counter restarts with every mount, so it is paired with a
   * per-mount generation: a page that remembers an old revision must not treat new
   * picks as already seen.
   */
  const generation = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  /** @type {{ revision: number, pick: object | null }} */
  const state = { revision: 0, pick: null }

  // Companion browser bridge: a loopback server the extension polls. It gets in where
  // a debugging port cannot — a browser the user already runs, logins untouched.
  const agentPath = join(dirname(fileURLToPath(import.meta.url)), 'extension', 'agent.js')
  let agentSource = ''
  const bridge = createBridge({
    port: extensionPort,
    agentSource: () => {
      if (agentSource !== '') return agentSource
      try {
        agentSource = readFileSync(agentPath, 'utf8')
      } catch (error) {
        agentSource = ''
      }
      return agentSource
    },
    onPick: (pick) => {
      state.pick = { ...pick, receivedAt: Date.now() }
      state.revision += 1
      health.error = ''
    },
  })

  // Providers decide what a click means; outputs decide where the pick goes. Both are
  // user-extensible, so nothing downstream assumes a specific source.
  const engine = createEngine({
    home: process.env.DSH_HOME,
    inputs: Array.isArray(config.inputs) ? config.inputs : undefined,
    outputs: Array.isArray(config.outputs) ? config.outputs : undefined,
    firstOnly: config.firstOnly === true,
    onPick: (pick) => {
      state.pick = { ...pick, receivedAt: Date.now() }
      state.revision += 1
      health.error = ''
      try {
        ctx.emit('element-picker/pick', pick)
      } catch (error) {
        /* no listener is fine */
      }
    },
  })
  void engine.reload()

  // Public surface for other plugins: they can add providers/outputs at runtime or
  // feed picks from their own integrations (a CDP bridge, an editor plugin, …).
  const api = {
    registerProvider: engine.registerProvider,
    registerOutput: engine.registerOutput,
    resolve: engine.resolve,
    pushPick: engine.pushPick,
    describe: engine.describe,
    reload: engine.reload,
    formatPick: engine.formatPick,
    helpers: engine.helpers,
  }
  try {
    ctx.provide('elementPicker', api)
  } catch (error) {
    try {
      ctx.set?.('elementPicker', api)
    } catch (inner) {
      health.error = 'elementPicker service unavailable: ' + String(error).slice(0, 120)
    }
  }
  const health = { helper: false, error: '', hotkey, startedAt: 0, polls: 0 }
  /** True while the DSH window has focus: the client handles the hotkey itself then. */
  const ui = { focused: false, focusedAt: 0 }

  const handler = async (req, res) => {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      if (url.pathname === `${ROUTE}/pick` && req.method === 'POST') {
        const pick = await readJson(req)
        state.pick = { ...pick, receivedAt: Date.now() }
        state.revision += 1
        health.error = ''
        sendJson(res, 200, { ok: true, revision: state.revision })
        return
      }

      // Browser windows do not expose their DOM to UI Automation; when the browser
      // was started with a debugging port, the tab itself is asked for the element.
      if (url.pathname === `${ROUTE}/cdp/pick` && req.method === 'POST') {
        const body = await readJson(req)
        const outcome = await pickInBrowser({ windowTitle: body.windowTitle })
        if (outcome.ok !== true) {
          sendJson(res, 200, outcome)
          return
        }
        state.pick = { ...outcome.pick, cdp: true, receivedAt: Date.now() }
        state.revision += 1
        health.error = ''
        sendJson(res, 200, { ok: true, revision: state.revision })
        return
      }

      // The page-side picker arms the bridge for the length of one pick session; the
      // companion extension only learns a token while armed.
      if (url.pathname === `${ROUTE}/arm` && req.method === 'POST') {
        const body = await readJson(req)
        if (body !== null && body.armed === false) bridge.disarm()
        else bridge.arm()
        sendJson(res, 200, { ok: true, ...bridge.status() })
        return
      }

      if (url.pathname === `${ROUTE}/extension` && req.method === 'GET') {
        sendJson(res, 200, {
          ...bridge.status(),
          port: extensionPort,
          enabled: extension,
          installPath: join(dirname(fileURLToPath(import.meta.url)), 'extension'),
        })
        return
      }

      if (url.pathname === `${ROUTE}/cdp/status` && req.method === 'GET') {
        const found = await findDebugPort()
        if (found === null) {
          sendJson(res, 200, { available: false })
          return
        }
        const targets = await listTargets(found.port)
        sendJson(res, 200, {
          available: true,
          port: found.port,
          browser: found.version?.Browser ?? '',
          targets: targets.map((target) => ({ id: target.id, title: target.title, url: target.url })),
        })
        return
      }

      // The web client reports whether its window has focus: while it does, the client
      // owns the hotkey and the native helper must stay out of the way.
      if (url.pathname === `${ROUTE}/focus` && req.method === 'POST') {
        const body = await readJson(req)
        ui.focused = body.focused === true
        ui.focusedAt = Date.now()
        sendJson(res, 200, { ok: true, focused: ui.focused })
        return
      }

      if (url.pathname === `${ROUTE}/state` && req.method === 'GET') {
        health.polls += 1
        const since = Number(url.searchParams.get('since') ?? '0')
        const fresh = Number.isFinite(since) && since < state.revision
        sendJson(res, 200, {
          generation,
          revision: state.revision,
          hotkey,
          enabled,
          helper: health.helper,
          error: health.error,
          polls: health.polls,
          clientFocused: ui.focused,
          external,
          referenceStyle,
          textDetail,
          pick: fresh ? state.pick : null,
        })
        return
      }

      // Cheap routing decision: who handles this click, and on which side.
      if (url.pathname === `${ROUTE}/plan` && req.method === 'POST') {
        const body = await readJson(req)
        const point = body.point ?? { x: 0, y: 0 }
        sendJson(
          res,
          200,
          engine.plan({
            point: { x: Number(point.x) || 0, y: Number(point.y) || 0 },
            window: body.window ?? {},
            hotkey,
          }),
        )
        return
      }

      if (url.pathname === `${ROUTE}/resolve` && req.method === 'POST') {
        const body = await readJson(req)
        const point = body.point ?? { x: 0, y: 0 }
        const outcome = await engine.resolve({
          point: { x: Number(point.x) || 0, y: Number(point.y) || 0 },
          window: body.window ?? {},
          hotkey,
        })
        sendJson(res, 200, outcome)
        return
      }

      if (url.pathname === `${ROUTE}/protocols` && req.method === 'GET') {
        sendJson(res, 200, engine.describe())
        return
      }

      if (url.pathname === `${ROUTE}/protocols/reload` && req.method === 'POST') {
        sendJson(res, 200, await engine.reload())
        return
      }

      sendJson(res, 404, { error: 'not-found' })
    } catch (error) {
      sendJson(res, 500, { error: String(error) })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
    'element-picker: OS pick routes',
  )

  // Bridge lifetime follows the mount; a token is only handed out while a pick session
  // is armed (see the /arm route), so the loopback port is not a standing door.
  ctx.effect(() => {
    if (!extension) return () => {}
    bridge.start()
    return () => bridge.stop()
  }, 'element-picker: companion bridge')

  ctx.effect(() => {
    if (!enabled || !external) return () => {}
    const script = join(dirname(fileURLToPath(import.meta.url)), 'native', 'os-pick.ps1')
    if (!existsSync(script)) {
      health.error = 'native/os-pick.ps1 missing'
      return () => {}
    }

    let child = null
    let stopped = false
    let restart = null

    const start = () => {
      restart = null
      if (stopped || child !== null) return
      if (liveHelper !== null && liveHelper !== child) {
        try {
          liveHelper.kill()
        } catch (error) {
          /* already gone */
        }
        liveHelper = null
      }
      let origin = ''
      try {
        origin = ctx.webServer.getOrigin()
      } catch (error) {
        health.error = 'no web origin'
        return
      }
      try {
        child = spawn(
          POWERSHELL,
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            script,
            '-BaseUrl',
            origin,
            '-Hotkey',
            hotkey,
            '-LockPath',
            join(dirname(script), '..', 'os-pick.lock'),
            '-Language',
            language,
          ],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        )
      } catch (error) {
        health.error = String(error).slice(0, 200)
        return
      }
      health.helper = true
      health.startedAt = Date.now()
      liveHelper = child
      child.unref()
      child.stdout?.on('data', () => {})
      child.stderr?.on('data', (chunk) => {
        health.error = String(chunk).trim().slice(0, 200)
      })
      child.on('exit', (code) => {
        if (liveHelper === child) liveHelper = null
        child = null
        health.helper = false
        // 3 = another instance of this plugin already owns the hotkey; retrying would
        // only spin a process every few seconds.
        if (code === 3) {
          health.error = 'another element-picker helper is already running'
          return
        }
        if (!stopped) restart = setTimeout(start, 4000)
      })
    }

    start()

    return () => {
      stopped = true
      if (restart !== null) clearTimeout(restart)
      if (child !== null) {
        const dying = child
        if (liveHelper === dying) liveHelper = null
        child = null
        // Close the pipes first: killing a child whose stdio handles are still open
        // during host shutdown trips libuv's assertion on Windows.
        try {
          dying.stdout?.destroy()
          dying.stderr?.destroy()
          dying.kill()
        } catch (error) {
          /* already gone */
        }
      }
      health.helper = false
    }
  }, 'element-picker: OS pick helper')
}
