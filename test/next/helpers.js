// Shared helpers for the new core's tests (spec 011), on Node and Bare.
// Adapted from test/brittle/helpers.js. Built-ins come through the package's
// imports map (fs, path, os, process → bare-* under Bare).

const fs = require('fs')
const path = require('path')
const os = require('os')
const process = require('process')
const createTestnet = require('hyperdht/testnet')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Whichever comes first: `promise`, or `fallback` after `ms`. The timer is
// cleared either way (a plain Promise.race with sleep() keeps the process
// alive until the timer fires).
async function within (promise, ms, fallback = null) {
  let timer = null
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// Polls `fn` until it returns something truthy, up to `ms`. Returns that value,
// or null on timeout. For "every member agrees within 1 s".
async function eventually (fn, ms = 5000, every = 25) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() >= until) return null
    await sleep(every)
  }
}

// The code of the error `promise` rejects with (its message if it has none),
// or null if it resolves.
async function codeOf (promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err.code || err.message
  }
}

let counter = 0

// A fresh temp directory removed after the test (with retries: Windows keeps
// files locked for a moment after RocksDB and the cores close).
function tmpDir (t, label = 'hg') {
  const dir = path.join(os.tmpdir(), `hg-next-${label}-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  t.teardown(() => removeDir(dir), { order: 1000 })
  return dir
}

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

// One small local DHT (3 nodes on 127.0.0.1) per test, created on first use and
// destroyed after the test's own teardowns. HG_TEST_PUBLIC_DHT=1 uses the
// public DHT instead.
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

// Runs a teardown step with a bound, so one stuck close never hangs the file.
async function bounded (promise, ms, label) {
  const result = await within(Promise.resolve(promise).then(() => 'ok', (err) => err), ms, 'timeout')
  if (result === 'timeout') console.log(`    [teardown] ${label} did not finish within ${ms} ms`)
  return result
}

// Opens a Hypergraph in a temp dir on the test's local DHT; closed after the test.
async function open (t, opts = {}) {
  const { Hypergraph } = require('../../lib/index.js')
  const dir = opts.dir || tmpDir(t, opts.label)
  const bootstrap = opts.bootstrap === undefined ? await testBootstrap(t) : opts.bootstrap
  const hg = await Hypergraph.open(dir, { ...opts, bootstrap })
  t.teardown(() => bounded(hg.close(), 10000, 'hg.close()'), { order: 0 })
  hg.dir = dir
  return hg
}

// N instances at once.
async function openMany (t, n, opts = {}) {
  const out = []
  for (let i = 0; i < n; i++) out.push(await open(t, { label: `m${i}`, ...opts }))
  return out
}

// Bytes the files under a folder take (what the app uses on disk).
function diskUse (dir) {
  let n = 0
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    n += st.isDirectory() ? diskUse(full) : st.size
  }
  return n
}

module.exports = { diskUse, sleep, within, eventually, codeOf, tmpDir, removeDir, testBootstrap, bounded, open, openMany }
