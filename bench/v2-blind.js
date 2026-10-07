// Research experiment (availability, blind peering): can a v2 community be
// read from a blind peer once its author is gone, and does the data arrive
// through plain replication, with nothing blind-peer specific on the reader?
//
//   node bench/v2-blind.js [--messages N] [--idle MS] [--mirrors M] [--drop D]
//
// One process, a local DHT (hyperdht/testnet), one blind peer server.
//   1. author: posts N messages in a public channel it keeps, asks the blind
//      peer to keep its control log (addAutobase), roster and log (addCore),
//      waits until the blind peer holds them, then closes completely.
//   2. reader: a fresh peer that only asks the blind peer for the control log
//      (addAutobase): time to the channel list, to the latest page, bytes.
//   3. after --idle ms with nothing read (the client drops idle connections),
//      the reader scrolls back: does it still work?
// --mirrors M blind peers (each core goes to 2 of them, blind-peering's
// default); --drop D of them are closed before the reader comes.

const path = require('path')
const fs = require('fs')
const os = require('os')
const hcrypto = require('hypercore-crypto')
const Corestore = require('corestore')
const HyperDHT = require('hyperdht')
const createTestnet = require('hyperdht/testnet')
const BlindPeer = require('blind-peer')
const BlindPeering = require('blind-peering')
const b4a = require('b4a')
const { Community } = require('../src/v2')

const argValue = (name, def) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? def : Number(process.argv[i + 1])
}
const sleep = (t) => new Promise(resolve => setTimeout(resolve, t))
const log = (...a) => console.error('[v2-blind]', ...a)

async function until (fn, ms = 60000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await fn()) return true } catch {}
    await sleep(50)
  }
  return false
}

async function main () {
  const messages = argValue('--messages', 200)
  const idle = argValue('--idle', 15000)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-v2blind-'))
  const result = { messages }
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap
  try {
    // The blind peer servers.
    const servers = []
    for (let i = 0; i < argValue('--mirrors', 1); i++) {
      const s = new BlindPeer(path.join(root, `blind-peer-${i}`), { bootstrap })
      await s.ready()
      await s.listen()
      servers.push(s)
    }
    const mirrors = servers.map(s => ({ key: s.publicKey }))

    // 1. The author.
    const authorDht = new HyperDHT({ bootstrap })
    const authorStore = new Corestore(path.join(root, 'author'))
    const author = new Community(authorStore, { identity: { keyPair: hcrypto.keyPair() }, replicate: 'sparse' })
    await author.ready()
    const channel = await author.createChannel({ name: 'general', keep: true })
    let last = null
    for (let i = 0; i < messages; i++) last = await author.post(channel, `message ${i}`)
    const peering = new BlindPeering(authorDht, authorStore, { blindPeers: mirrors })
    let t0 = Date.now()
    await peering.addAutobase(author.control.base)
    const roster = authorStore.get({ key: b4a.from(author.keepers(channel)[0].rosterKey, 'hex') })
    const ownLog = authorStore.get({ key: b4a.from(last.log, 'hex') })
    await peering.addCore(roster)
    await peering.addCore(ownLog)
    const heldBy = async (server, core) => {
      const copy = server.store.get({ key: core.key })
      await copy.ready()
      const ok = copy.length === core.length && copy.length > 0 && await copy.has(0, copy.length)
      await copy.close()
      return ok
    }
    const holders = async (core) => { let n = 0; for (const s of servers) if (await heldBy(s, core)) n++; return n }
    result.handedOver = await until(async () => (await holders(roster)) >= Math.min(2, servers.length) && (await holders(ownLog)) >= Math.min(2, servers.length))
    result.copies = { roster: await holders(roster), log: await holders(ownLog) }
    result.handOverMs = Date.now() - t0
    log('blind peer holds roster and log:', result.handedOver, result.handOverMs, 'ms')
    await roster.close()
    await ownLog.close()
    await peering.close()
    await author.close()
    await authorStore.close()
    await authorDht.destroy()
    log('author gone')
    for (let i = 0; i < argValue('--drop', 0); i++) {
      const s = servers.shift()
      await s.close()
      log('dropped a blind peer')
    }

    // 2. A fresh reader, asking the blind peer for the control log only.
    const readerDht = new HyperDHT({ bootstrap })
    const readerStore = new Corestore(path.join(root, 'reader'))
    const reader = new Community(readerStore, { identity: { keyPair: hcrypto.keyPair() }, key: author.key, replicate: 'sparse' })
    await reader.ready()
    const readerPeering = new BlindPeering(readerDht, readerStore, { blindPeers: mirrors })
    t0 = Date.now()
    // Background: addAutobase() waits for every chosen mirror to connect, and
    // hangs while one of them is down (measured: --mirrors 2 --drop 1).
    readerPeering.addAutobaseBackground(reader.control.base)
    result.controlOk = await until(async () => { await reader.update(); return reader.channels().length === 1 })
    result.controlMs = Date.now() - t0
    let page = []
    result.pageOk = await until(async () => (page = await reader.latest(channel, { limit: 50, timeout: 2000 })).length === 50 && page[0].text === `message ${messages - 1}`)
    result.pageMs = Date.now() - t0
    log('reader: control', result.controlOk, result.controlMs, 'ms; page', result.pageOk, result.pageMs, 'ms')

    // 3. Idle, then something not read yet.
    await sleep(idle)
    t0 = Date.now()
    let older = []
    result.afterIdleOk = await until(async () => (older = await reader.before(channel, { t: page[page.length - 1].t, limit: 50, timeout: 2000 })).length === 50, 20000)
    result.afterIdleMs = Date.now() - t0
    log('after', idle, 'ms idle: scrollback', result.afterIdleOk, result.afterIdleMs, 'ms')
    void older

    await readerPeering.close()
    await reader.close()
    await readerStore.close()
    await readerDht.destroy()
    for (const s of servers) await s.close()
  } finally {
    await testnet.destroy()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
  console.log(JSON.stringify(result))
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1) })
