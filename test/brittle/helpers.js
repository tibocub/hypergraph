const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const createTestnet = require('hyperdht/testnet')
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
 * Whichever comes first: `promise`, or `fallback` after `ms`. The timer is
 * cleared either way. A plain Promise.race against sleep() leaves the timer
 * running, which keeps the test process alive until it fires (measured: up
 * to 20 s idle at the end of a file).
 */
async function within (promise, ms, fallback = null) {
  let timer = null
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wait until every given Hyperswarm instance reports at least one live
 * connection. `discovery.flushed()` only proves the local side's own DHT
 * announce/lookup round finished — it does NOT prove an actual peer-to-peer
 * connection exists yet. Use this before assuming any peer is reachable.
 * swarm.flush() is never used here or in the retry below — per hyperswarm's
 * own README it's heavyweight and unrelated to whether a connection has
 * actually succeeded; this function's own polling loop is the real check.
 *
 * If `topic` is provided and the initial wait times out, this will leave and
 * rejoin the topic on every swarm (up to `retries` times) before giving up.
 * This matters most for tests where 3+ peers all join the same topic at
 * nearly the same wall-clock moment with no single peer announcing first
 * (unlike a simple 2-peer owner/member pattern, where the owner's own
 * announce has time to fully land before the other side ever looks for it)
 * — an occasional stale initial DHT lookup in that scenario is a real,
 * inherent characteristic of genuinely simultaneous multi-way joins, not
 * evidence of anything wrong in how the join itself is done. A fresh
 * join/flush cycle can succeed where the first one didn't.
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
  const { topic = null, joinOpts = { server: true, client: true } } = opts
  // Measured: when every peer joins at once, the first lookup usually runs
  // before the others have announced, finds nobody, and Hyperswarm only
  // looks again ~10 minutes later. A rejoin connects in ~2 s. So wait short
  // and rejoin (one peer after another), doubling the wait each time (1, 2,
  // 4 ... 32 s), within
  // about the same total budget, instead of waiting out timeoutMs first
  // (multi-peer.js spent 60 s per test in the first wait).
  const retries = topic ? Math.max(opts.retries || 1, 6) : (opts.retries || 1)

  for (let attempt = 0; ; attempt++) {
    const attemptMs = topic ? Math.min(timeoutMs, 1000 * 2 ** attempt) : timeoutMs
    const start = Date.now()
    let timedOut = false
    let counts = []

    for (;;) {
      counts = swarms.map(({ name, swarm }) => ({ name, count: swarm.connections.size }))
      if (counts.every((c) => c.count > 0)) {
        console.log(`    connections established (attempt ${attempt + 1}): ${counts.map((c) => `${c.name}=${c.count}`).join(', ')}`)
        return counts
      }
      if (Date.now() - start > attemptMs) {
        timedOut = true
        break
      }
      await sleep(100)
    }

    console.log(`    TIMEOUT waiting for connections (attempt ${attempt + 1}): ${counts.map((c) => `${c.name}=${c.count}`).join(', ')}`)

    if (!timedOut || attempt >= retries || !topic) return counts

    console.log(`    retrying: leaving and rejoining the topic on all swarms (${retries - attempt} attempt(s) left)`)
    for (const { swarm } of swarms) {
      try { await swarm.leave(topic) } catch (err) { /* may already have left */ }
    }
    await sleep(200)
    for (const { swarm } of swarms) {
      const disc = swarm.join(topic, joinOpts)
      // swarm.flush() deliberately not awaited here — per hyperswarm's own
      // README it's unrelated to whether a connection has succeeded; the
      // polling loop above already detects that directly.
      try { await disc.flushed() } catch (err) { /* best-effort */ }
    }
  }
}

/**
 * Run a teardown operation (destroying a swarm, a discovery session, a
 * HypergraphNetwork instance, etc.) with a hard timeout, so a single stuck
 * operation can never hang the whole test process. If it times out, this
 * logs a warning and moves on rather than blocking indefinitely — teardown
 * should never be the reason a test suite hangs forever; a slow or stuck
 * cleanup should be visible, not silent, and should never prevent the rest
 * of teardown (or the process) from completing.
 *
 * @param {Promise<any>} promise
 * @param {number} ms
 * @param {string} label - what's being torn down, for the log line
 */
async function withTeardownTimeout (promise, ms, label) {
  const result = await within(
    Promise.resolve(promise).then((value) => ({ timedOut: false, value, error: null })).catch((error) => ({ timedOut: false, value: null, error })),
    ms,
    { timedOut: true, value: null, error: null }
  )
  if (result.timedOut) {
    console.log(`    [teardown] ${label} did not finish within ${ms}ms — abandoning it so the rest of teardown can proceed`)
  } else if (result.error) {
    console.log(`    [teardown] ${label} threw during cleanup: ${result.error.message}`)
  }
  return result.value
}

/**
 * Properly destroy a Hyperswarm instance: Hyperswarm.destroy() never
 * explicitly closes already-established peer connections (confirmed by
 * reading its source — `this.connections` is only ever added to/removed
 * from for bookkeeping, never iterated or destroyed inside destroy()).
 * `clear()` only handles discovery sessions, `server.close()` only stops
 * accepting new inbound connections, and `dht.destroy()` tears down the
 * DHT node — none of them touch an already-live connection stream. If a
 * test actually replicated data over a connection, that stream can be left
 * open indefinitely, which is enough on its own to keep a process from
 * exiting. Destroy every active connection explicitly first.
 *
 * @param {import('hyperswarm')} swarm
 */
async function destroySwarm (swarm) {
  for (const conn of [...swarm.connections]) {
    try { conn.destroy() } catch (err) { /* already closed */ }
  }
  try { await swarm.destroy({ force: true }) } catch (err) { /* already closed */ }
  // force:true skips each topic's discovery teardown, and with it the
  // clearing of its ~10-minute refresh timer — which then kept the whole
  // test process alive for ~10 minutes (measured: the only live handles
  // left were two PeerDiscovery._refreshLater timers). Destroying each
  // discovery now clears it; the DHT is already gone, so the unannounce it
  // attempts fails fast instead of waiting on the network. Bounded anyway.
  // (`_discovery` is Hyperswarm's own topic map; no public accessor.)
  const discoveries = swarm._discovery ? [...swarm._discovery.values()] : []
  let timer = null
  await Promise.race([
    Promise.all(discoveries.map(d => Promise.resolve(d.destroy()).catch(() => {}))),
    new Promise(resolve => { timer = setTimeout(resolve, 5000) })
  ])
  clearTimeout(timer) // a pending 5 s timer would itself keep the process alive
}

// One small local DHT (3 nodes on 127.0.0.1) per test, created on first use
// and destroyed after the test's own teardowns. Network tests use real
// Hyperswarm/UDP through it, without the public DHT: on the public DHT,
// lookups and shutdowns cost seconds each, and running files in parallel
// made them flaky. HG_TEST_PUBLIC_DHT=1 runs them on the public DHT instead.
const testnets = new WeakMap()

async function testBootstrap (t) {
  if (process.env.HG_TEST_PUBLIC_DHT) return undefined
  let testnet = testnets.get(t)
  if (!testnet) {
    testnet = createTestnet(3, t.teardown)
    testnets.set(t, testnet)
  }
  return (await testnet).bootstrap
}

async function testSwarm (t, opts = {}) {
  const bootstrap = await testBootstrap(t)
  return new Hyperswarm(bootstrap ? { ...opts, bootstrap } : opts)
}

module.exports = { createGraph, removeDirWithRetry, sleep, within, waitForConnections, withTeardownTimeout, destroySwarm, testSwarm, testBootstrap }
