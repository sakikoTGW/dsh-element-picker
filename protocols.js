/**
 * dsh-element-picker — protocol engine.
 *
 * Nothing about a pick is hard-coded here: a **provider** turns a screen context
 * (pointer + window) into a normalized pick, and an **output** decides where that
 * pick goes. Both are ordered registries, and both accept user modules.
 *
 * Provider (host JS module, `export default { ... }`):
 *   id: string                      unique, e.g. 'browser-cdp'
 *   priority: number                higher runs first (default 0)
 *   match(ctx): boolean             cheap check: does this provider apply?
 *   pick(ctx): Promise<Pick|null>   resolve it; null means "not mine"
 *
 * Output:
 *   id: string
 *   priority: number
 *   accept(pick, ctx): boolean      first accepting output handles the pick
 *   deliver(pick, ctx): Promise<void>
 *
 * Context:
 *   { point: { x, y }, window: { class, title, processId, processName }, hotkey }
 *
 * Pick (all optional except label):
 *   { label, kind: 'element'|'url'|'file', text, selector, page, resource, path,
 *     source, meta }
 *
 * User modules live in `$DSH_HOME/element-picker/providers/*.mjs` and
 * `$DSH_HOME/element-picker/outputs/*.mjs`; they are imported on demand and never
 * cached beyond their mtime.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findDebugPort, pickInBrowser } from './cdp.js'

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const HERE = dirname(fileURLToPath(import.meta.url))

/** Where users drop their own protocols. */
export function userDirs(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  const root = join(home, 'element-picker')
  return {
    root,
    providers: join(root, 'providers'),
    outputs: join(root, 'outputs'),
  }
}

function ensureUserDirs(home) {
  const dirs = userDirs(home)
  for (const dir of [dirs.providers, dirs.outputs]) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    } catch (error) {
      /* a read-only home only costs user modules */
    }
  }
  return dirs
}

/** Run the native helper once for a point; it prints one JSON pick. */
function nativePick(point, signal) {
  return new Promise((resolve) => {
    const script = join(HERE, 'native', 'os-pick.ps1')
    if (!existsSync(script)) {
      resolve(null)
      return
    }
    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Point', `${Math.round(point.x)},${Math.round(point.y)}`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    const done = (value) => {
      try {
        child.kill()
      } catch (error) {
        /* already gone */
      }
      resolve(value)
    }
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
    })
    child.on('exit', () => {
      const line = out.trim().split('\n').pop() || ''
      try {
        const parsed = JSON.parse(line)
        if (parsed && parsed.error) resolve(null)
        else resolve(parsed)
      } catch (error) {
        resolve(null)
      }
    })
    child.on('error', () => resolve(null))
    signal?.addEventListener('abort', () => done(null), { once: true })
    setTimeout(() => done(null), 4000).unref?.()
  })
}

/** UI Automation through the native helper — the general desktop provider. */
const uiaProvider = {
  id: 'uia',
  label: '桌面控件（UI Automation）',
  priority: 10,
  // Runs inside the native helper: it already has UI Automation loaded, so no extra
  // PowerShell process is spawned per pick.
  where: 'helper',
  match() {
    return true
  },
  async pick(ctx) {
    const raw = await nativePick(ctx.point)
    if (raw === null) return null
    const control = [raw.controlType, raw.name].filter(Boolean).join(' · ')
    return {
      kind: 'element',
      label: (raw.windowOnly === true ? raw.windowTitle || control : control || raw.windowTitle || '').slice(0, 80),
      text: raw.text || raw.name || '',
      window: [raw.processName, raw.windowTitle].filter(Boolean).join(' — '),
      controlType: raw.controlType || '',
      automationId: raw.automationId || '',
      className: raw.className || '',
      bounds: raw.bounds || null,
      windowOnly: raw.windowOnly === true,
      source: 'uia',
      meta: { processId: raw.processId, chain: raw.chain },
    }
  },
}

/** Chromium windows: hand the pick to the tab over the DevTools protocol. */
const cdpProvider = {
  id: 'browser-cdp',
  label: '浏览器页面（CDP）',
  priority: 100,
  where: 'host',
  match(ctx) {
    return /Chrome_WidgetWin/i.test(ctx.window?.class || '')
  },
  async pick(ctx) {
    const outcome = await pickInBrowser({ windowTitle: ctx.window?.title || '' })
    if (outcome.ok !== true) return null
    const pick = outcome.pick
    return {
      kind: 'element',
      label: String(pick.label || pick.text || '').slice(0, 80),
      text: String(pick.text || ''),
      selector: String(pick.selector || ''),
      page: String(pick.page || ''),
      source: 'browser-cdp',
      meta: { port: pick.port, targetId: pick.targetId, tag: pick.tag },
    }
  },
}

/** Whether the desktop itself should be resolved as a wallpaper image. */
const desktopWallpaperProvider = {
  id: 'desktop-wallpaper',
  label: '桌面壁纸（图片）',
  priority: 60,
  where: 'host',
  match(ctx) {
    // The desktop is explorer's WorkerW/Progman with no title; only claim it when the
    // probe element is that surface, so ordinary windows keep their own provider.
    const cls = ctx.window?.class || ''
    const title = ctx.window?.title || ''
    return /Progman|WorkerW|SHELLDLL_DefView/i.test(cls) || (title === '' && /explorer/i.test(ctx.window?.processName || ''))
  },
  async pick(ctx) {
    const file = await wallpaperPath(ctx)
    if (file === null) return null
    const parts = file.split(/[\\/]/u).filter(Boolean)
    return {
      kind: 'file',
      label: parts[parts.length - 1] || '壁纸',
      path: file,
      source: 'desktop-wallpaper',
      meta: { wallpaper: true },
    }
  },
}

function runPowerShell(script, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve('')
      return
    }
    let out = ''
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
    })
    child.on('error', () => resolve(''))
    child.on('exit', () => resolve(out.trim()))
    setTimeout(() => {
      try {
        child.kill()
      } catch (error) {
        /* gone */
      }
      resolve(out.trim())
    }, timeoutMs).unref?.()
  })
}

async function wallpaperPath() {
  const script =
    "$p = (Get-ItemProperty 'HKCU:\\Control Panel\\Desktop' -ErrorAction SilentlyContinue).Wallpaper; " +
    'if ($p) { $p }'
  const path = await runPowerShell(script)
  return path === '' ? null : path
}

/** Compose the clipboard/model text for a pick, mirroring the client's chip body. */
export function formatPick(pick) {
  const lines = []
  if (pick.kind === 'file') lines.push('[引用文件] ' + (pick.label || ''))
  else if (pick.kind === 'url') lines.push('[引用网址] ' + (pick.label || ''))
  else lines.push('[引用元素] ' + (pick.label || ''))
  if (pick.selector) lines.push('选择器: ' + pick.selector)
  if (pick.window) lines.push('窗口: ' + pick.window)
  if (pick.controlType) lines.push('控件: ' + pick.controlType)
  const locator = [pick.automationId ? 'AutomationId=' + pick.automationId : '', pick.className ? 'Class=' + pick.className : '']
    .filter(Boolean)
    .join(' ')
  if (locator) lines.push('定位: ' + locator)
  if (pick.resource) lines.push('资源: ' + pick.resource)
  if (pick.page) lines.push('页面: ' + pick.page)
  if (pick.path) lines.push('路径: ' + pick.path)
  if (pick.text) lines.push('文本: ' + pick.text)
  return lines.join('\n')
}

/** The default output: hand the pick to the DSH client, which inserts a chip. */
function composerOutput(push) {
  return {
    id: 'composer',
    label: 'DSH 输入框（引用 chip）',
    priority: 100,
    accept() {
      return true
    },
    async deliver(pick) {
      push(pick)
    },
  }
}

/** Copy the reference block instead — the "进复制框" path. */
const clipboardOutput = {
  id: 'clipboard',
  label: '剪贴板（文本）',
  priority: 10,
  accept() {
    return true
  },
  async deliver(pick) {
    const text = formatPick(pick)
    const encoded = Buffer.from(text, 'utf8').toString('base64')
    await runPowerShell(
      `$t = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); Set-Clipboard -Value $t`,
      3000,
    )
  },
}

const helpers = {
  cdp: { pickInBrowser, findDebugPort },
  runPowerShell,
  formatPick,
}

async function importUserModule(file) {
  const url = pathToFileURL(file).href + '?v=' + statSync(file).mtimeMs
  const loaded = await import(url)
  const definition = loaded.default
  if (definition === null || typeof definition !== 'object' || typeof definition.id !== 'string') return null
  return definition
}

/**
 * Build the engine.
 * @param {{ home?: string, inputs?: string[], onPick: (pick: object) => void }} options
 */
export function createEngine(options) {
  const home = options.home
  const dirs = ensureUserDirs(home)
  const builtins = [cdpProvider, desktopWallpaperProvider, uiaProvider]
  /** Providers/outputs registered by other plugins at runtime. */
  const runtimeProviders = new Map()
  const runtimeOutputs = new Map()
  const builtinOutputs = [composerOutput(options.onPick), clipboardOutput]
  let providers = [...builtins]
  let outputs = [...builtinOutputs]
  let baseProviders = [...builtins]
  let baseOutputs = [...builtinOutputs]
  let loadErrors = []
  let generation = 0

  const selectedIds = Array.isArray(options.inputs) && options.inputs.length > 0 ? options.inputs : null
  const selectedOutputs = Array.isArray(options.outputs) && options.outputs.length > 0 ? options.outputs : null
  const firstOnly = options.firstOnly === true

  async function loadUserModules() {
    loadErrors = []
    const userProviders = []
    const userOutputs = []
    for (const [dir, target, kind] of [
      [dirs.providers, userProviders, 'provider'],
      [dirs.outputs, userOutputs, 'output'],
    ]) {
      let files = []
      try {
        files = readdirSync(dir).filter((name) => name.endsWith('.mjs') || name.endsWith('.js'))
      } catch (error) {
        files = []
      }
      for (const name of files) {
        try {
          const module = await importUserModule(join(dir, name))
          if (module === null) {
            loadErrors.push({ file: name, reason: 'missing export default { id, … }' })
            continue
          }
          const entry = { ...module, origin: 'user', file: join(dir, name), kind }
          if (kind === 'provider') {
            if (typeof entry.match !== 'function' || typeof entry.pick !== 'function') {
              loadErrors.push({ file: name, reason: 'provider needs match() and pick()' })
              continue
            }
            userProviders.push(entry)
          } else {
            if (typeof entry.deliver !== 'function') {
              loadErrors.push({ file: name, reason: 'output needs deliver()' })
              continue
            }
            userOutputs.push(entry)
          }
        } catch (error) {
          loadErrors.push({ file: name, reason: String(error).slice(0, 200) })
        }
      }
    }

    const withOrigin = builtins.map((entry) => ({ ...entry, origin: 'builtin', kind: 'provider' }))
    const outputOrigin = builtinOutputs.map((entry) => ({ ...entry, origin: 'builtin', kind: 'output' }))
    let allProviders = [...withOrigin, ...userProviders]
    let allOutputs = [...outputOrigin, ...userOutputs]
    if (selectedIds !== null) {
      const chosen = allProviders.filter((entry) => selectedIds.includes(entry.id))
      allProviders = chosen.length > 0 ? chosen : allProviders
    }
    if (selectedOutputs !== null) {
      const chosen = allOutputs.filter((entry) => selectedOutputs.includes(entry.id))
      allOutputs = chosen.length > 0 ? chosen : allOutputs
    }
    baseProviders = allProviders
    baseOutputs = allOutputs
    rebuild()
  }

  /** Merge built-in/user/system layers with runtime registrations, then sort. */
  function rebuild() {
    providers = [...baseProviders, ...runtimeProviders.values()].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    )
    outputs = [...baseOutputs, ...runtimeOutputs.values()].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    )
    generation += 1
  }

  async function reload() {
    await loadUserModules()
    return describe()
  }

  function describe() {
    return {
      generation,
      dirs,
      errors: loadErrors,
      providers: providers.map((entry) => ({
        id: entry.id,
        label: entry.label ?? entry.id,
        priority: entry.priority ?? 0,
        origin: entry.origin,
        where: entry.where === 'helper' ? 'helper' : 'host',
        file: entry.file,
      })),
      outputs: outputs.map((entry) => ({
        id: entry.id,
        label: entry.label ?? entry.id,
        priority: entry.priority ?? 0,
        origin: entry.origin,
        file: entry.file,
      })),
    }
  }

  /**
   * Decide who should handle this context without doing the work: host providers run
   * here (CDP, wallpaper), helper providers run inside the native helper so a click
   * does not pay for a fresh PowerShell process.
   */
  function plan(ctx) {
    for (const provider of providers) {
      let applies = false
      try {
        applies = provider.match(ctx) === true
      } catch (error) {
        applies = false
      }
      if (!applies) continue
      return { ok: true, provider: provider.id, where: provider.where === 'helper' ? 'helper' : 'host' }
    }
    return { ok: true, provider: 'uia', where: 'helper' }
  }

  /** Resolve one context, then let the first output that accepts it deliver. */
  async function resolve(rawContext) {
    // User protocols get the same building blocks the built-ins use.
    const ctx = { ...rawContext, helpers }
    for (const provider of providers) {
      let applies = false
      try {
        applies = provider.match(ctx) === true
      } catch (error) {
        applies = false
      }
      if (!applies) continue
      let pick = null
      try {
        // A user provider that hangs must not hold the whole click hostage.
        const timeout = Number(provider.timeoutMs) > 0 ? Number(provider.timeoutMs) : 3000
        pick = await Promise.race([
          provider.pick(ctx),
          new Promise((resolve) => setTimeout(() => resolve(null), timeout).unref?.()),
        ])
      } catch (error) {
        pick = null
      }
      if (pick === null || pick === undefined) continue
      const enriched = { ...pick, provider: provider.id }
      const delivered = []
      for (const output of outputs) {
        let accepts = false
        try {
          accepts = output.accept(enriched, ctx) === true
        } catch (error) {
          accepts = false
        }
        if (!accepts) continue
        try {
          await output.deliver(enriched, ctx)
          delivered.push(output.id)
        } catch (error) {
          /* one failing output must not block the others */
        }
        if (firstOnly) break
      }
      if (delivered.length === 0) {
        return { ok: false, reason: 'no-output', pick: enriched, provider: provider.id }
      }
      return { ok: true, pick: enriched, provider: provider.id, output: delivered[0], outputs: delivered }
    }
    return { ok: false, reason: 'no-provider' }
  }

  function registerProvider(definition) {
    if (definition === null || typeof definition !== 'object' || typeof definition.id !== 'string') {
      throw new Error('provider needs an id')
    }
    if (typeof definition.match !== 'function' || typeof definition.pick !== 'function') {
      throw new Error('provider needs match() and pick()')
    }
    runtimeProviders.set(definition.id, { ...definition, origin: 'plugin', kind: 'provider' })
    rebuild()
    return () => {
      runtimeProviders.delete(definition.id)
      rebuild()
    }
  }

  function registerOutput(definition) {
    if (definition === null || typeof definition !== 'object' || typeof definition.id !== 'string') {
      throw new Error('output needs an id')
    }
    if (typeof definition.deliver !== 'function') {
      throw new Error('output needs deliver()')
    }
    runtimeOutputs.set(definition.id, { ...definition, origin: 'plugin', kind: 'output' })
    rebuild()
    return () => {
      runtimeOutputs.delete(definition.id)
      rebuild()
    }
  }

  return {
    reload,
    describe,
    resolve,
    dirs,
    registerProvider,
    registerOutput,
    plan,
    pushPick: (pick) => options.onPick(pick),
    formatPick,
    helpers,
  }
}
