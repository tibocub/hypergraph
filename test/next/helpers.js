// Shared helpers for the new core's tests (spec 011), on Node and Bare.
// Built-ins come through the package's imports map (fs, path → bare-* under Bare).

const fs = require('fs')
const path = require('path')
// The local DHT, temp folders and waits are the public test helper's (spec 018).
const { within, eventually, codeOf, tmpDir, bootstrap: testBootstrap, sleep } = require('hypergraph/testing')

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
