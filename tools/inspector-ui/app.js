async function api (path, method = 'GET', body = null) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  const txt = await res.text()
  let json = null
  try { json = txt ? JSON.parse(txt) : null } catch {}

  if (!res.ok) {
    const msg = json && json.error ? json.error : txt
    throw new Error(msg || `HTTP ${res.status}`)
  }

  return json
}

function $(id) {
  return document.getElementById(id)
}

const out = $('out')
const runtime = $('runtime')
const db = $('db')
const contextsInput = $('contexts')
const ctxKeyInput = $('ctxKey')
const ctxStatus = $('ctxStatus')

let initialGraph = null

function getScopeContexts () {
  return contextsInput.value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

async function runAndRender (body) {
  const t0 = performance.now()
  const res = await api('/api/query', 'POST', body)
  const t1 = performance.now()

  const ms = res && res.profile && typeof res.profile.durationMs === 'number' ? res.profile.durationMs : (t1 - t0)
  runtime.textContent = `durationMs=${ms.toFixed(2)}`

  out.textContent = JSON.stringify(res, null, 2)
  renderGraph(res.graph)
  return res
}

async function resetView () {
  if (initialGraph) {
    runtime.textContent = ''
    out.textContent = JSON.stringify({ graph: initialGraph, mode: 'reset' }, null, 2)
    renderGraph(initialGraph)
    return
  }

  const contexts = getScopeContexts()
  const res = await runAndRender({
    scope: { contexts },
    query: { type: 'all', limit: 500, includeEdges: true, edgeLimit: 200 }
  })
  initialGraph = res.graph
}

const cy = cytoscape({
  container: $('cy'),
  elements: [],
  style: [
    { selector: 'node', style: { 'label': 'data(label)', 'background-color': '#3b82f6', 'color': '#111827', 'text-outline-width': 2, 'text-outline-color': '#fff' } },
    { selector: 'node[type = "tag"]', style: { 'background-color': '#f59e0b' } },
    { selector: 'edge', style: { 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'width': 2, 'line-color': '#9ca3af', 'target-arrow-color': '#9ca3af', 'label': 'data(label)', 'font-size': 10, 'text-rotation': 'autorotate' } },
    { selector: '.faded', style: { 'opacity': 0.15, 'text-opacity': 0.15 } },
    { selector: '.highlight', style: { 'opacity': 1, 'text-opacity': 1, 'line-color': '#111827', 'target-arrow-color': '#111827', 'background-color': '#111827' } }
  ],
  layout: { name: 'cose' }
})

function renderGraph (graph) {
  const els = []

  const nodeIds = new Set()

  for (const n of (graph.nodes || [])) {
    if (!n || !n.id) continue
    nodeIds.add(n.id)
    const label = n.type === 'tag'
      ? `#${n.tag || n.id}`
      : `${n.type || 'node'}\n${n.id}`
    els.push({ data: { id: n.id, label, type: n.type || null } })
  }

  let i = 0
  for (const e of (graph.edges || [])) {
    if (!e || !e.from || !e.to) continue
    if (!nodeIds.has(e.from)) nodeIds.add(e.from), els.push({ data: { id: e.from, label: e.from, type: null } })
    if (!nodeIds.has(e.to)) nodeIds.add(e.to), els.push({ data: { id: e.to, label: e.to, type: null } })
    const id = `e${i++}:${e.from}->${e.to}:${e.type || ''}:${e.context || ''}:${e.createdAt || ''}`
    els.push({ data: { id, source: e.from, target: e.to, label: e.type || '' } })
  }

  cy.elements().remove()
  cy.add(els)
  cy.layout({ name: 'cose', animate: false }).run()
}

function clearFocus () {
  cy.elements().removeClass('faded')
  cy.elements().removeClass('highlight')
}

function focusOn (node) {
  if (!node) return
  const neighborhood = node.closedNeighborhood()
  cy.elements().addClass('faded')
  neighborhood.removeClass('faded')
  neighborhood.addClass('highlight')
}

cy.on('tap', (ev) => {
  if (ev.target === cy) {
    clearFocus()
  }
})

cy.on('select', 'node', (ev) => {
  clearFocus()
  focusOn(ev.target)
})

async function refreshMeta () {
  const meta = await api('/api/meta')
  db.textContent = meta && meta.corestoreDir ? meta.corestoreDir : ''
  out.textContent = JSON.stringify(meta, null, 2)

  if (meta && Array.isArray(meta.openedContexts) && !contextsInput.value.trim()) {
    contextsInput.value = meta.openedContexts.join(',')
  }

  return meta
}

function patchQueryContexts () {
  const contexts = getScopeContexts()

  const q = JSON.parse($('query').value)
  q.scope = q.scope || {}
  q.scope.contexts = contexts
  $('query').value = JSON.stringify(q, null, 2)
}

contextsInput.addEventListener('change', () => {
  try { patchQueryContexts() } catch {}
})

$('newdb').addEventListener('click', async () => {
  try {
    await api('/api/newdb', 'POST', {})
    await refreshMeta()
  } catch (err) {
    out.textContent = String(err && err.message ? err.message : err)
  }
})

$('update').addEventListener('click', async () => {
  try {
    await api('/api/update', 'POST', {})
    await refreshMeta()
  } catch (err) {
    out.textContent = String(err && err.message ? err.message : err)
  }
})

$('run').addEventListener('click', async () => {
  try {
    const body = JSON.parse($('query').value)
    await runAndRender(body)
  } catch (err) {
    out.textContent = String(err && err.message ? err.message : err)
  }
})

$('reset').addEventListener('click', async () => {
  try {
    await resetView()
  } catch (err) {
    out.textContent = String(err && err.message ? err.message : err)
  }
})

$('put').addEventListener('click', async () => {
  try {
    const entityType = $('entityType').value.trim()
    const node = await api('/api/write/put', 'POST', { entityType })
    out.textContent = JSON.stringify(node, null, 2)
  } catch (err) {
    out.textContent = String(err && err.message ? err.message : err)
  }
})

$('ctxCreate').addEventListener('click', async () => {
  try {
    ctxStatus.textContent = ''
    const res = await api('/api/context/create', 'POST', { writeMode: 'open' })
    ctxKeyInput.value = res.keyHex

    const meta = await refreshMeta()
    contextsInput.value = Array.isArray(meta.openedContexts) ? meta.openedContexts.join(',') : contextsInput.value
    patchQueryContexts()
    ctxStatus.textContent = `created ${res.keyHex}`
  } catch (err) {
    ctxStatus.textContent = String(err && err.message ? err.message : err)
  }
})

$('ctxOpen').addEventListener('click', async () => {
  try {
    ctxStatus.textContent = ''
    const keyHex = ctxKeyInput.value.trim()
    const res = await api('/api/context/open', 'POST', { keyHex, writeMode: 'open' })
    ctxKeyInput.value = res.keyHex

    const meta = await refreshMeta()
    contextsInput.value = Array.isArray(meta.openedContexts) ? meta.openedContexts.join(',') : contextsInput.value
    patchQueryContexts()
    ctxStatus.textContent = `opened ${res.keyHex}`
  } catch (err) {
    ctxStatus.textContent = String(err && err.message ? err.message : err)
  }
})

$('ctxWriters').addEventListener('click', async () => {
  try {
    ctxStatus.textContent = ''
    const keyHex = ctxKeyInput.value.trim()
    const res = await api(`/api/context/${keyHex}/writers`, 'GET')
    out.textContent = JSON.stringify(res, null, 2)
    ctxStatus.textContent = `writers: ${Array.isArray(res.writers) ? res.writers.length : 0}`
  } catch (err) {
    ctxStatus.textContent = String(err && err.message ? err.message : err)
  }
})

$('openBootstrap').addEventListener('click', async () => {
  try {
    ctxStatus.textContent = ''
    const res = await api('/api/bootstrap/openFromDisk', 'POST', {})
    const meta = await refreshMeta()
    contextsInput.value = Array.isArray(meta.openedContexts) ? meta.openedContexts.join(',') : contextsInput.value
    patchQueryContexts()
    ctxStatus.textContent = `opened bootstrap: ${res.bootstrapPath}`
    initialGraph = null
    await resetView()
  } catch (err) {
    ctxStatus.textContent = String(err && err.message ? err.message : err)
  }
})

$('openSite').addEventListener('click', async () => {
  try {
    ctxStatus.textContent = ''
    const res = await api('/api/site/openFromDisk', 'POST', {})
    const meta = await refreshMeta()
    contextsInput.value = Array.isArray(meta.openedContexts) ? meta.openedContexts.join(',') : contextsInput.value
    patchQueryContexts()
    ctxStatus.textContent = `opened site: ${res.manifestPath}`
    initialGraph = null
    await resetView()
  } catch (err) {
    ctxStatus.textContent = String(err && err.message ? err.message : err)
  }
})

;(async function init () {
  try {
    // ensure session exists
    try {
      await refreshMeta()
    } catch {
      await api('/api/newdb', 'POST', {})
      await refreshMeta()
    }

    patchQueryContexts()

    // default the editor to 'all' if it still has the original starter query
    try {
      const q = JSON.parse($('query').value)
      if (q && q.query && q.query.type === 'nodeByType') {
        q.query = { type: 'all', limit: 500, includeEdges: true, edgeLimit: 200 }
        $('query').value = JSON.stringify(q, null, 2)
      }
    } catch {}

    // initial full view
    await resetView()
  } catch (err) {
    out.textContent = String(err && err.message ? err.message : err)
  }
})()
