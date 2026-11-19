/**
 * Helpers for apps' own tests: a local DHT per test, temp folders, instances closed after the test,
 * and waits that leave no timer. Works with any test runner whose test object has `teardown(fn)`
 * (brittle) or `after(fn)` (node:test). Nothing here goes around the API (hypergraph's own test hooks
 * are in lib/testing.js).
 * @example
 * const { open, eventually } = require('hypergraph/testing')
 * @module hypergraph/testing
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const process = require('process')

/**
 * Resolves after `ms`.
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Whichever comes first: `promise`, or `fallback` after `ms`. The timer is cleared either way (a
 * `Promise.race` with a sleep would keep the process alive).
 * @param {Promise} promise
 * @param {number} ms
 * @param {*} [fallback=null]
 * @returns {Promise<*>}
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
 * Polls `fn` until it returns something truthy, up to `ms`.
 * @param {function(): *} fn May be async.
 * @param {number} [ms=5000]
 * @param {number} [every=25] Poll interval (ms).
 * @returns {Promise<*>} That value, or null.
 */
async function eventually (fn, ms = 5000, every = 25) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() >= until) return null
    await sleep(every)
  }
}

/**
 * The code of the error `promise` rejects with (its message if it has none).
 * @param {Promise} promise
 * @returns {Promise<string|null>} null if it resolves.
 */
async function codeOf (promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err.code || err.message
  }
}

// What a test made, cleaned up at its end in this order whatever order it was
// made in: instances, then the DHT, then folders.
const states = new WeakMap()

function stateOf (t) {
  let state = states.get(t)
  if (state) return state
  state = { instances: [], testnet: null, dirs: [] }
  const cleanup = () => cleanUp(state)
  // order 1000 (brittle): after the test's own teardowns, so they close what
  // they opened before its folder goes.
  if (typeof t?.teardown === 'function') t.teardown(cleanup, { order: 1000 })
  else if (typeof t?.after === 'function') t.after(cleanup)
  else throw new TypeError('hypergraph/testing: the test object needs teardown(fn) or after(fn)')
  states.set(t, state)
  return state
}

async function cleanUp (state) {
  for (const hg of state.instances.reverse()) await bounded(hg.close(), 10000, 'close()')
  if (state.testnet) await bounded(state.testnet.then((net) => net.destroy()), 10000, 'the local DHT')
  for (const dir of state.dirs) await removeDir(dir)
}

// One stuck close never hangs the test.
async function bounded (promise, ms, label) {
  const result = await within(Promise.resolve(promise).then(() => 'ok', (err) => err), ms, 'timeout')
  if (result === 'timeout') console.log(`    [teardown] ${label} did not finish within ${ms} ms`)
  return result
}

// Windows keeps files locked a moment after the stores close: retry.
async function removeDir (dir) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await sleep(200 * attempt)
    }
  }
}

let counter = 0

/**
 * A fresh empty folder, removed after the test.
 * @param {object} t The test object: needs `teardown(fn)` (brittle) or `after(fn)` (node:test).
 * @param {string} [label='hg'] Part of the folder's name.
 * @returns {string}
 */
function tmpDir (t, label = 'hg') {
  const state = stateOf(t)
  const dir = path.join(os.tmpdir(), `hg-${label}-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  state.dirs.push(dir)
  return dir
}

/**
 * The bootstrap list of the test's own DHT (3 nodes on 127.0.0.1), started on first use and destroyed
 * after the test. With `HG_TEST_PUBLIC_DHT=1`: undefined, the public DHT.
 * @param {object} t
 * @returns {Promise<Array|undefined>}
 */
async function bootstrap (t) {
  if (process.env.HG_TEST_PUBLIC_DHT) return undefined
  const state = stateOf(t)
  if (!state.testnet) state.testnet = require('hyperdht/testnet')(3)
  return (await state.testnet).bootstrap
}

/**
 * A {@link Hypergraph} in a new temp folder on the test's DHT, online, closed after the test.
 * @param {object} t
 * @param {object} [opts] Options of {@link Hypergraph.open}, plus `dir` to reopen a folder.
 * @returns {Promise<Hypergraph>} With `hg.dir`, its folder.
 */
async function open (t, opts = {}) {
  const { Hypergraph } = require('./index.js')
  const { dir = tmpDir(t), ...rest } = opts
  const hg = await Hypergraph.open(dir, { bootstrap: await bootstrap(t), ...rest })
  stateOf(t).instances.push(hg)
  await hg.connectToSwarm()
  hg.dir = dir
  return hg
}

module.exports = { open, bootstrap, tmpDir, within, eventually, codeOf, sleep }
