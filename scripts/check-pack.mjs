#!/usr/bin/env node
/**
 * Pack sanity: every file listed in package.json `files` exists, the manifest parses,
 * nothing carries a UTF-8 BOM (a BOM in package.json once stopped the loader from
 * mounting the bundle), and the protocol doc ships.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] || '.'
const problems = []

const manifestPath = join(root, 'package.json')
const raw = readFileSync(manifestPath)
if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) problems.push('package.json has a BOM')

let manifest
try {
  manifest = JSON.parse(raw.toString('utf8'))
} catch (error) {
  console.error('package.json does not parse:', error.message)
  process.exit(1)
}

const required = ['index.js', 'client.js', 'cordis.patch.yml', 'PROTOCOL.md']
for (const name of required) {
  if (!existsSync(join(root, name))) problems.push('missing required file: ' + name)
}

for (const entry of manifest.files || []) {
  if (entry.includes('*')) {
    const dir = join(root, entry.split('/')[0])
    if (!existsSync(dir)) problems.push('files entry matches nothing: ' + entry)
    continue
  }
  if (!existsSync(join(root, entry))) problems.push('files entry missing on disk: ' + entry)
}

for (const name of readdirSync(root)) {
  const full = join(root, name)
  if (!statSync(full).isFile()) continue
  if (!/\.(js|mjs|json|yml|md|ps1)$/.test(name)) continue
  const bytes = readFileSync(full)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) problems.push('BOM in ' + name)
}

if (problems.length > 0) {
  for (const problem of problems) console.error('✗', problem)
  process.exit(1)
}
console.log('✓ pack ok:', manifest.name, manifest.version, '(' + (manifest.files || []).length + ' entries)')
