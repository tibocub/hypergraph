// Shared helpers for the v2 prototype tests.

const os = require('os')
const path = require('path')
const fs = require('fs')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const { Community } = require('../../../src/v2')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function tmpStore (t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hg-v2-${label}-`))
  const store = new Corestore(dir)
  t.teardown(async () => {
    await store.close().catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 })
  }, { order: Infinity })
  return { store, dir }
}

// A member: its own store and identity, and a Community opened on it.
async function member (t, label, opts = {}) {
  const { store, dir } = tmpStore(t, label)
  const identity = opts.identity || { keyPair: crypto.keyPair() }
  const community = new Community(store, { ...opts, identity })
  await community.ready()
  t.teardown(() => community.close())
  return { store, dir, identity, community, pub: identity.keyPair.publicKey.toString('hex') }
}

function link (a, b) {
  const s1 = a.community.replicate(true)
  const s2 = b.community.replicate(false)
  s1.pipe(s2).pipe(s1)
  s1.on('error', () => {})
  s2.on('error', () => {})
  return () => { s1.destroy(); s2.destroy() }
}

async function until (fn, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(50)
  }
  return false
}

module.exports = { sleep, tmpStore, member, link, until }
