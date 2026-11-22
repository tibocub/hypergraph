// Shared helpers for the new core's tests, on Node and Bare.

const fs = require('fs')
const path = require('path')
const { within, eventually, codeOf, tmpDir, bootstrap: testBootstrap, sleep } = require('hypergraph/testing')

// 90 s, not brittle's 30: a test opening a few accounts can take over 30 s when several
// files share a slow disk (each open waits on its syncs), and then failed though nothing was wrong.
// A test's own `timeout` still wins.
try { require('brittle').configure({ timeout: 90000 }) } catch { /* tests already registered: theirs stays */ }

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

async function open (t, opts = {}) {
  const { Hypergraph } = require('../../lib/index.js')
  const dir = opts.dir || tmpDir(t, opts.label)
  const bootstrap = opts.bootstrap === undefined ? await testBootstrap(t) : opts.bootstrap
  const hg = await Hypergraph.open(dir, { ...opts, bootstrap })
  t.teardown(() => bounded(hg.close(), 10000, 'hg.close()'), { order: 0 })
  hg.dir = dir
  return hg
}

async function openMany (t, n, opts = {}) {
  const out = []
  for (let i = 0; i < n; i++) out.push(await open(t, { label: `m${i}`, ...opts }))
  return out
}

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
