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

/**
 * Wait until every given Hyperswarm instance reports at least one live
 * connection. `discovery.flushed()` only proves the local side's own DHT
 * announce/lookup round finished — it does NOT prove an actual peer-to-peer
 * connection exists yet. Use this before assuming any peer is reachable.
 *
 * If `topic` is provided and the initial wait times out, this will leave and
 * rejoin the topic on every swarm (up to `retries` times) before giving up.
 * A stale initial DHT lookup occasionally returns candidate peers that never
 * pan out; a fresh join/flush cycle can succeed where the first one didn't.
 *
 * @param {Array<{ name: string, swarm: import('hyperswarm') }>} swarms
 * @param {number} [timeoutMs] - How long to wait per attempt
 * @param {Object} [opts]
 * @param {Buffer} [opts.topic] - Shared topic to rejoin on timeout
 * @param {number} [opts.retries] - Number of rejoin attempts after the first (default 1)
 * @param {Object} [opts.joinOpts] - Passed to swarm.join() on rejoin
 * @returns {Promise<Array<{ name: string, count: number }>>}
 */
async function waitForConnections (swarms, timeoutMs = 60000, opts = {}) {
  const { topic = null, retries = 1, joinOpts = { server: true, client: true } } = opts

  for (let attempt = 0; ; attempt++) {
    const start = Date.now()
    let timedOut = false
    let counts = []

    for (;;) {
      counts = swarms.map(({ name, swarm }) => ({ name, count: swarm.connections.size }))
      if (counts.every((c) => c.count > 0)) {
        console.log(`    connections established (attempt ${attempt + 1}): ${counts.map((c) => `${c.name}=${c.count}`).join(', ')}`)
        return counts
      }
      if (Date.now() - start > timeoutMs) {
        timedOut = true
        break
      }
      await sleep(1000)
    }

    console.log(`    TIMEOUT waiting for connections (attempt ${attempt + 1}): ${counts.map((c) => `${c.name}=${c.count}`).join(', ')}`)

    if (!timedOut || attempt >= retries || !topic) return counts

    console.log(`    retrying: leaving and rejoining the topic on all swarms (${retries - attempt} attempt(s) left)`)
    for (const { swarm } of swarms) {
      try { await swarm.leave(topic) } catch (err) { /* may already have left */ }
    }
    await sleep(1000)
    for (const { swarm } of swarms) {
      const disc = swarm.join(topic, joinOpts)
      try { await disc.flushed() } catch (err) { /* best-effort */ }
      try { await swarm.flush() } catch (err) { /* best-effort */ }
    }
  }
}

module.exports = { createGraph, removeDirWithRetry, sleep, waitForConnections }
