/**
 * Page kernel for the companion extension.
 *
 * Injected into the active tab in the ISOLATED world for one pick session: it paints
 * the outline, resolves what is under the pointer, and hands one payload back. It is
 * removed the moment the session ends — it does not read the page otherwise, does not
 * persist and does not observe anything after the pick.
 */
;(function install(formToken) {
  if (window.__dshRefAgent && window.__dshRefAgent.token === formToken) return

  const Z = '2147483647'
  const KERNEL = 'dsh-ref-1'

  const overlay = document.createElement('div')
  overlay.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'z-index:' + Z,
    'border:2px solid rgb(76,141,255)',
    'border-radius:3px',
    'background:rgba(76,141,255,.10)',
    'transition:none',
    'display:none',
    'box-sizing:border-box',
  ].join(';')

  const tip = document.createElement('div')
  tip.style.cssText = [
    'position:fixed',
    'z-index:' + Z,
    'pointer-events:none',
    'max-width:70vw',
    'padding:3px 7px',
    'border-radius:5px',
    'background:rgba(18,26,40,.94)',
    'color:#fff',
    'font:12px/1.4 system-ui,sans-serif',
    'white-space:nowrap',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'display:none',
  ].join(';')

  let current = null
  let active = true

  function clip(text, length) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, length)
  }

  function labelOf(node) {
    const name = node.getAttribute('aria-label') || node.getAttribute('title') || ''
    const text = clip(name || node.textContent || '', 60)
    return text !== '' ? text : node.tagName.toLowerCase()
  }

  function selectorOf(node) {
    if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) return '#' + node.id
    const testId = node.getAttribute('data-testid')
    if (testId) {
      const sel = '[data-testid="' + testId.replace(/"/g, '\\"') + '"]'
      if (document.querySelectorAll(sel).length === 1) return sel
    }
    const parts = []
    let element = node
    while (element !== null && element !== document.documentElement) {
      const tag = element.tagName.toLowerCase()
      const parent = element.parentElement
      if (parent === null) {
        parts.unshift(tag)
        break
      }
      const same = Array.from(parent.children).filter((child) => child.tagName === element.tagName)
      const at = same.indexOf(element) + 1
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + at + ')' : tag)
      element = parent
      if (parts.length >= 6) break
    }
    return parts.join(' > ')
  }

  function stateOf(node) {
    const parts = []
    const attr = (name) => node.getAttribute(name)
    const expanded = attr('aria-expanded')
    if (expanded !== null) parts.push(expanded === 'true' ? 'expanded' : 'collapsed')
    if (attr('aria-pressed') === 'true') parts.push('pressed')
    const checked = attr('aria-checked')
    if (checked !== null) parts.push(checked === 'true' ? 'checked' : 'unchecked')
    if (attr('aria-selected') === 'true') parts.push('selected')
    if (attr('aria-disabled') === 'true' || node.disabled === true) parts.push('disabled')
    return parts.join(' ')
  }

  function nearbyOf(node) {
    const parent = node.parentElement
    if (parent === null) return ''
    const names = []
    for (const child of Array.from(parent.children)) {
      if (child === node) continue
      if (names.length >= 4) break
      const label = clip(child.getAttribute('aria-label') || child.textContent || '', 16)
      if (label !== '') names.push(label)
    }
    return names.join(' / ')
  }

  function contextOf(node) {
    const parts = []
    let element = node
    for (let depth = 0; depth < 4 && element !== null && element !== document.body; depth += 1) {
      const parent = element.parentElement
      if (parent === null) break
      const label = parent.getAttribute('aria-label') || parent.getAttribute('data-testid') || ''
      if (label !== '') parts.unshift(clip(label, 24))
      else {
        const heading = Array.from(parent.children).find((child) => /^H[1-6]$/.test(child.tagName))
        if (heading) parts.unshift(clip(heading.textContent, 24))
      }
      element = parent
    }
    return parts.filter(Boolean).join(' > ')
  }

  function indexOf(node) {
    const parent = node.parentElement
    if (parent === null) return ''
    const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName)
    if (same.length <= 1) return ''
    const row = node.closest('tr')
    if (row !== null && row.parentElement !== null) {
      const rowIndex = Array.from(row.parentElement.children).indexOf(row) + 1
      const cell = node.closest('td,th')
      const colIndex = cell === null ? 0 : Array.from(row.children).indexOf(cell) + 1
      return '#' + (same.indexOf(node) + 1) + '/' + same.length + ' row ' + rowIndex + (colIndex > 0 ? ' col ' + colIndex : '')
    }
    return '#' + (same.indexOf(node) + 1) + '/' + same.length
  }

  function boxOf(node) {
    const rect = node.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    return {
      x: Math.round((rect.left + window.scrollX) * dpr),
      y: Math.round((rect.top + window.scrollY) * dpr),
      w: Math.round(rect.width * dpr),
      h: Math.round(rect.height * dpr),
      viewport: Math.round(window.innerWidth * dpr) + 'x' + Math.round(window.innerHeight * dpr),
    }
  }

  function payloadOf(node) {
    return {
      kind: 'element',
      label: labelOf(node),
      selector: selectorOf(node),
      state: stateOf(node),
      box: boxOf(node),
      nearby: nearbyOf(node),
      index: indexOf(node),
      context: contextOf(node),
      content: (node.getAttribute('role') || node.tagName.toLowerCase()) + ' >> text=' + clip(labelOf(node), 40),
      text: clip(node.getAttribute('aria-label') || node.textContent, 240),
      page: location.href,
      frame: '',
      provider: 'extension',
    }
  }

  function paint(node) {
    if (node === null || node.nodeType !== 1) {
      overlay.style.display = 'none'
      tip.style.display = 'none'
      return
    }
    const rect = node.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) {
      overlay.style.display = 'none'
      tip.style.display = 'none'
      return
    }
    overlay.style.display = 'block'
    overlay.style.left = rect.left + 'px'
    overlay.style.top = rect.top + 'px'
    overlay.style.width = rect.width + 'px'
    overlay.style.height = rect.height + 'px'
    const label = labelOf(node)
    const extra = stateOf(node)
    tip.textContent = label + (extra !== '' ? ' · ' + extra : '') + '  (点击引用 · Esc 取消)'
    tip.style.display = 'block'
    const top = rect.top > 26 ? rect.top - 26 : rect.bottom + 6
    tip.style.left = Math.max(4, Math.min(window.innerWidth - 40, rect.left)) + 'px'
    tip.style.top = top + 'px'
  }

  // Skip the repaint entirely while the pointer travels: getBoundingClientRect on a
  // huge tree is cheap, but paint-thrash is not, and the box would lag anyway.
  let lastX = -1
  let lastY = -1
  let lastNode = null

  function onMove(event) {
    if (!active) return
    const x = Math.round(event.clientX)
    const y = Math.round(event.clientY)
    if (x === lastX && y === lastY) return
    lastX = x
    lastY = y
    const node = document.elementFromPoint(event.clientX, event.clientY)
    if (node === overlay || node === tip) return
    if (node === lastNode) return
    lastNode = node
    paint(node)
  }

  function onDown(event) {
    if (!active) return
    event.preventDefault()
    event.stopPropagation()
    const node = document.elementFromPoint(event.clientX, event.clientY)
    if (node === null) return
    const payload = payloadOf(node)
    stop()
    try {
      chrome.runtime.sendMessage({ type: 'dsh-ref-pick', payload })
    } catch (error) {
      /* extension context gone */
    }
  }

  function onKey(event) {
    if (event.key !== 'Escape' || !active) return
    event.preventDefault()
    event.stopPropagation()
    stop()
    try {
      chrome.runtime.sendMessage({ type: 'dsh-ref-cancel' })
    } catch (error) {
      /* extension context gone */
    }
  }

  function stop() {
    active = false
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('click', onDown, true)
    document.removeEventListener('keydown', onKey, true)
    overlay.remove()
    tip.remove()
    if (window.__dshRefAgent && window.__dshRefAgent.kernel === KERNEL) window.__dshRefAgent = null
  }

  document.documentElement.appendChild(overlay)
  document.documentElement.appendChild(tip)
  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('mousedown', onDown, true)
  document.addEventListener('click', onDown, true)
  document.addEventListener('keydown', onKey, true)

  window.__dshRefAgent = { kernel: KERNEL, token: formToken, stop }
})(window.__dshRefAgentToken || '')
