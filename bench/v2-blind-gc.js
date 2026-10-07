// Research experiment (availability, blind peering): what a blind peer does
// when it is full. C communities, each one author posting N messages and
// handing its control log, roster and log to one blind peer capped at
// --max-bytes; every author then leaves. Which communities can a fresh reader
// still read?
//
//   node bench/v2-blind-gc.js [--communities C] [--messages N] [--max-bytes B] [--heal]
//
// --heal: before the readers come, the first author comes back for a moment
// and hands its cores to the blind peer again (it still has them).

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
const step = (...a) => console.error('[v2-blind-gc]', ...a)

// Each attempt bounded too: a reader whose data was collected waits in
// update() for blocks nobody holds any more (found here).
async function until (fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    let timer = null
    try {
      const ok = await Promise.race([fn(), new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(100, end - Date.now())) })])
      if (ok) return true
    } catch {} finally { clearTimeout(timer) }
    await sleep(50)
  }
  return false
}

async function main () {
  const communities = argValue('--communities', 4)
  const messages = argValue('--messages', 200)
  const maxBytes = argValue('--max-bytes', 60000)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-v2blindgc-'))
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap
  const gcs = []
  const out = { communities, messages, maxBytes, handed: [], readable: [] }
  try {
    const server = new BlindPeer(path.join(root, 'blind-peer'), { bootstrap, maxBytes })
    server.on('gc-done', (e) => { gcs.push(e.bytesCleared); step('gc-done', e.bytesCleared) })
    await server.ready()
    await server.listen()
    const mirrors = [{ key: server.publicKey }]

    const made = []
    for (let c = 0; c < communities; c++) {
      const dht = new HyperDHT({ bootstrap })
      const store = new Corestore(path.join(root, `author-${c}`))
      const author = new Community(store, { identity: { keyPair: hcrypto.keyPair() }, replicate: 'sparse' })
      await author.ready()
      const channel = await author.createChannel({ name: 'general', keep: true })
      let last = null
      for (let i = 0; i < messages; i++) last = await author.post(channel, `community ${c} message ${i}: some text of a usual length`)
      const peering = new BlindPeering(dht, store, { blindPeers: mirrors })
      step(c, 'posted')
      await peering.addAutobase(author.control.base)
      step(c, 'autobase added')
      const roster = store.get({ key: b4a.from(author.keepers(channel)[0].rosterKey, 'hex') })
      const ownLog = store.get({ key: b4a.from(last.log, 'hex') })
      await peering.addCore(roster)
      await peering.addCore(ownLog)
      step(c, 'cores added')
      const copy = server.store.get({ key: ownLog.key })
      await copy.ready()
      out.handed.push(await until(async () => copy.length === ownLog.length && await copy.has(0, copy.length), 20000))
      step(c, 'handed', out.handed[out.handed.length - 1])
      await copy.close()
      await roster.close()
      await ownLog.close()
      await peering.close()
      await author.close()
      await store.close()
      await dht.destroy()
      step(c, 'author closed')
      made.push({ dir: path.join(root, `author-${c}`), identity: author, rosterKey: author.keepers(channel)[0].rosterKey, log: last.log, key: author.key, channel, last: `community ${c} message ${messages - 1}: some text of a usual length` })
      await sleep(500) // let the blind peer flush (and collect, if over its cap)
    }
    if (process.argv.includes('--heal')) {
      const m = made[0]
      const dht = new HyperDHT({ bootstrap })
      const store = new Corestore(m.dir)
      const peering = new BlindPeering(dht, store, { blindPeers: mirrors })
      const cores = [store.get({ key: b4a.from(m.rosterKey, 'hex') }), store.get({ key: b4a.from(m.log, 'hex') })]
      for (const core of cores) await peering.addCore(core)
      const copy = server.store.get({ key: cores[1].key })
      await copy.ready()
      out.healed = await until(async () => copy.length > 0 && await copy.has(0, copy.length), 10000)
      step('healed', out.healed)
      await copy.close()
      for (const core of cores) await core.close()
      await peering.close()
      await store.close()
      await dht.destroy()
    }
    out.gcRuns = gcs.length
    out.bytesCleared = gcs.reduce((a, b) => a + b, 0)
    out.digest = { bytesAllocated: server.digest.bytesAllocated }

    for (const m of made) {
      const dht = new HyperDHT({ bootstrap })
      const store = new Corestore(path.join(root, `reader-${b4a.toString(m.key, 'hex').slice(0, 8)}`))
      const reader = new Community(store, { identity: { keyPair: hcrypto.keyPair() }, key: m.key, replicate: 'sparse' })
      await reader.ready()
      const peering = new BlindPeering(dht, store, { blindPeers: mirrors })
      peering.addAutobaseBackground(reader.control.base)
      const ok = await until(async () => {
        await reader.update()
        if (!reader.channel(m.channel)) return false
        const page = await reader.latest(m.channel, { limit: 50, timeout: 1000 })
        return page.length === 50 && page[0].text === m.last
      }, 10000)
      out.readable.push(ok)
      step('reader', ok)
      await peering.close()
      await reader.close()
      await store.close()
      await dht.destroy()
    }
    await server.close()
  } finally {
    await testnet.destroy()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
  console.log(JSON.stringify(out))
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1) })
