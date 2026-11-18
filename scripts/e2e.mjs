#!/usr/bin/env node
/**
 * End-to-end check against a running DSH host.
 *
 *   node scripts/e2e.mjs [baseUrl]
 *
 * Exercises the HTTP surface the UI depends on: the protocol registry, the routing
 * plan, a synthetic pick that must reach the pick queue, and the CDP status probe.
 * Exits non-zero on the first failed assertion so it can gate a release.
 */
const base = (process.argv[2] || process.env.DSH_WEB_URL || 'http://127.0.0.1:65277').replace(/\/$/, '')

let failures = 0
const ok = (label, condition, detail = '') => {
  if (condition) {
    console.log('✓', label)
  } else {
    failures += 1
    console.error('✗', label, detail)
  }
}

async function json(path, init) {
  const response = await fetch(base + path, init)
  if (!response.ok) throw new Error(path + ' -> HTTP ' + response.status)
  return response.json()
}

try {
  const protocols = await json('/element-picker/os/protocols')
  ok('protocol registry', Array.isArray(protocols.providers) && protocols.providers.length > 0)
  ok('providers declare where they run', protocols.providers.every((entry) => entry.where === 'host' || entry.where === 'helper'))
  ok('outputs registered', Array.isArray(protocols.outputs) && protocols.outputs.length > 0)
  ok('no module load errors', (protocols.errors || []).length === 0, JSON.stringify(protocols.errors))

  const plan = await json('/element-picker/os/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ point: { x: 10, y: 10 }, window: { class: '', title: '', processName: 'explorer' } }),
  })
  ok('plan answers', plan.ok === true && typeof plan.provider === 'string', JSON.stringify(plan))

  const before = await json('/element-picker/os/state?since=999999')
  const sample = {
    kind: 'element',
    label: 'e2e · 按钮',
    selector: '#e2e',
    page: 'https://example.test/e2e',
    text: 'e2e',
  }
  const posted = await json('/element-picker/os/pick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sample),
  })
  ok('pick accepted', posted.ok === true && posted.revision > (before.revision || 0), JSON.stringify(posted))

  const after = await json('/element-picker/os/state?since=0')
  ok('pick readable back', after.pick && after.pick.label === sample.label, JSON.stringify(after.pick))
  ok('generation present', typeof after.generation === 'string' && after.generation.length > 0)

  const cdp = await json('/element-picker/os/cdp/status')
  console.log('· cdp:', cdp.available ? 'port ' + cdp.port + ' (' + cdp.browser + ')' : 'no debugging port')
} catch (error) {
  failures += 1
  console.error('✗ request failed:', error.message)
  console.error('  is DSH running and the plugin mounted? base =', base)
}

process.exitCode = failures === 0 ? 0 : 1
