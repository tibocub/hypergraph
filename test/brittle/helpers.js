const Corestore = require('corestore')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { Hypergraph } = require('../../index.js')

/**
 * Create a fresh Hypergraph instance backed by a temp Corestore directory,
 * and register automatic teardown (graph, store, and directory cleanup).
 *
 * @param {import('brittle').Test} t - The brittle test context (for t.teardown)
 * @param {string} label - Short label used in the temp directory name
 * @param {Object} [opts] - Passed through to `new Hypergraph(store, opts)`
 * @returns {Promise<{ store: Corestore, graph: Hypergraph, dir: string }>}
 */
async function createGraph (t, label, opts = {}) {
  const dir = path.join(
    os.tmpdir(),
    `hypergraph-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  fs.mkdirSync(dir, { recursive: true })

  const store = new Corestore(dir)
  const graph = new Hypergraph(store, opts)
  await graph.ready()

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { await graph.close() } catch (err) { /* already closed */ }
    try { await store.close() } catch (err) { /* already closed */ }
  }

  t.teardown(async () => {
    await removeDirWithRetry(dir, close)
  })

  return { store, graph, dir, close }
}

/**
 * Remove a directory with retry/backoff to handle Windows file locking (EPERM)
 * after closing the resources that were using it.
 *
 * @param {string} dir
 * @param {() => Promise<void>} closeFn - called once before attempting removal
 */
async function removeDirWithRetry (dir, closeFn) {
  if (closeFn) {
    try {
      await closeFn()
    } catch (err) {
      // Resources may already be closed; ignore.
    }
  }

  const maxRetries = 10
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt === maxRetries) return
      await sleep(500 * attempt)
    }
  }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = { createGraph, removeDirWithRetry, sleep }
