// The three ways to hold a site (site-storage.md Q1, Q2):
//   space   - a SwarmFS space; every file an entry, its bytes through swarmwire
//   inline  - the same, but files up to INLINE_MAX go inside the record (bench-only prototype:
//             an extra `inline` record type; SwarmFS itself is unchanged)
//   drive   - a single-writer Hyperdrive (npm hyperdrive + corestore + hyperswarm)
//
// owner(variant, { bootstrap, dir, siteDir, files }) -> { address, close() }
// visitor(variant, { bootstrap, dir }) -> { visit(address, outDir) -> { times, ... }, close(), counts() }
// The visitor's engine is open and online before visit() starts: HyperBrowser's engine is running
// when someone opens a site. `open` (ms) says how long that took.

import fs from 'fs'
import path from 'path'
import { swarmfs, swarmfsLib, hypergraphNext, deps, eventually, now, ENTRY, writeSite } from './common.mjs'

export const INLINE_MAX = 60 * 1024 // a record is at most 64 KB (lib/encodings.js MAX_RECORD)

async function sfsOpen (dir, { bootstrap, inline, name }) {
  const { SwarmFS } = await swarmfs()
  if (!inline) return SwarmFS.open(dir, { bootstrap, deviceName: name, minFree: 0, fetchTimeout: 10000 })
  // SwarmFS.open, with one more type (SwarmFS.open takes no types of its own)
  const { types, rules } = await swarmfsLib('types.js')
  const { Hypergraph } = (await hypergraphNext()).default
  const hg = await Hypergraph.open(dir, {
    types: { ...types, inline: { fields: { name: 'string', parent: 'string', data: 'bytes' }, index: [['parent', 'stamp']], editable: 'members' } },
    rules,
    deviceName: name,
    bootstrap
  })
  const sfs = new SwarmFS(hg, { minFree: 0, fetchTimeout: 10000 })
  sfs._people()
  await hg.connectToSwarm()
  return sfs
}

// `filesOf(s)`: site s's files (default: `files` for every site); `siteDir` holds `files`.
export async function owner (variant, { bootstrap, dir, siteDir, files, sites = 1, filesOf = () => files }) {
  if (variant === 'drive') {
    const Corestore = deps('corestore')
    const Hyperdrive = deps('hyperdrive')
    const Hyperswarm = deps('hyperswarm')
    const store = new Corestore(dir)
    const swarm = new Hyperswarm({ bootstrap })
    swarm.on('connection', (c) => { try { store.replicate(c) } catch { c.destroy() } })
    const addresses = []
    const drives = []
    for (let s = 0; s < sites; s++) {
      const drive = new Hyperdrive(store.namespace('site-' + s))
      await drive.ready()
      for (const f of filesOf(s)) await drive.put('/' + f.name, f.data)
      // HD_JOIN=both: both sides dial (like spaces); works around the cross-process handshake stall (study, Q1)
      swarm.join(drive.discoveryKey, process.env.HD_JOIN === 'both' ? {} : { server: true, client: false })
      addresses.push(drive.key.toString('hex'))
      drives.push(drive)
    }
    await swarm.flush()
    return {
      addresses,
      address: addresses[0],
      async close () {
        await swarm.destroy()
        for (const d of drives) await d.close()
        await store.close()
      }
    }
  }
  const inline = variant === 'inline'
  const sfs = await sfsOpen(dir, { bootstrap, inline, name: 'owner' })
  const addresses = []
  for (let s = 0; s < sites; s++) {
    const drive = await sfs.createSpace('Site ' + s)
    if (inline) {
      const folder = await drive.space.put('folder', { name: 'site', parent: drive.top })
      const own = filesOf(s) === files ? siteDir : writeSite(path.join(dir, '..', path.basename(dir) + '-site-' + s), filesOf(s))
      for (const f of filesOf(s)) {
        if (f.data.byteLength <= INLINE_MAX) await drive.space.put('inline', { name: f.name, parent: folder.id, data: f.data })
        else await drive.add(path.join(own, f.name), { parent: folder.id })
      }
    } else {
      // each site its own copy on disk: one local file is one entry (SwarmFS _overlaps)
      const copy = path.join(dir, '..', path.basename(dir) + '-site-' + s)
      if (filesOf(s) === files) fs.cpSync(siteDir, copy, { recursive: true })
      else writeSite(copy, filesOf(s))
      await drive.add(copy)
    }
    addresses.push(await drive.invite({ uses: 1000 }))
  }
  return { addresses, address: addresses[0], sfs, close: () => sfs.close() }
}

export async function visitor (variant, { bootstrap, dir }) {
  const t0 = now()
  if (variant === 'drive') {
    const Corestore = deps('corestore')
    const Hyperdrive = deps('hyperdrive')
    const Hyperswarm = deps('hyperswarm')
    const store = new Corestore(dir)
    const swarm = new Hyperswarm({ bootstrap })
    swarm.on('connection', (c) => { try { store.replicate(c) } catch { c.destroy() } })
    await store.ready()
    const open = now() - t0
    const drives = []
    return {
      open,
      swarm,
      store,
      async visit (address) {
        const t = now()
        const drive = new Hyperdrive(store, Buffer.from(address, 'hex'))
        drives.push(drive)
        await drive.ready()
        const done = drive.findingPeers()
        swarm.join(drive.discoveryKey, process.env.HD_JOIN === 'both' ? {} : { server: false, client: true })
        swarm.flush().then(done, done)
        // flush() can end before the owner is connected (another process): wait for the first block
        const found = await eventually(async () => { await drive.core.update({ wait: true }); return drive.core.length > 0 }, 120000, 10)
        if (!found) throw new Error('never reached the owner')
        const joined = now() - t
        const got = await Promise.all(ENTRY.map((n) => drive.get('/' + n)))
        if (got.some((b) => !b)) throw new Error('entry files missing')
        const entry = now() - t
        const names = []
        for await (const e of drive.list('/', { recursive: true })) names.push(e.key)
        const all = await Promise.all(names.map((n) => drive.get(n)))
        if (all.some((b) => !b)) throw new Error('site files missing')
        return { joined, entry, all: now() - t, files: names.length }
      },
      connections: () => swarm.connections.size,
      async close () {
        await swarm.destroy()
        for (const d of drives) await d.close()
        await store.close()
      }
    }
  }
  const inline = variant === 'inline'
  const sfs = await sfsOpen(dir, { bootstrap, inline, name: 'visitor' })
  const open = now() - t0
  return {
    open,
    sfs,
    async visit (code, outDir) {
      const t = now()
      const drive = await sfs.join(code)
      const joined = now() - t
      const folder = await eventually(async () => (await drive.list(drive.top)).items.find((i) => i.kind === 'folder'), 30000, 10)
      if (!folder) throw new Error('the site folder never arrived')
      fs.mkdirSync(outDir, { recursive: true })
      const fetchAll = (items) => Promise.all(items.map((i) => drive.fetch(i.id, path.join(outDir, i.name))))
      let entry
      let total = 0
      if (inline) {
        // inline records: the bytes come with the record; written out like a fetch would be
        const space = drive.space
        const listInline = async () => (await space.query('inline').where({ parent: folder.id }).latest(100)).items
        const atEntry = await eventually(async () => { const items = await listInline(); return ENTRY.every((n) => items.some((i) => i.name === n)) && items }, 30000, 10)
        for (const i of atEntry.filter((i) => ENTRY.includes(i.name))) fs.writeFileSync(path.join(outDir, i.name), i.data)
        entry = now() - t
        const files = await eventually(async () => { const l = await drive.list(folder.id); return l.complete && l.items }, 30000, 10)
        const rest = (await listInline()).filter((i) => !ENTRY.includes(i.name))
        for (const i of rest) fs.writeFileSync(path.join(outDir, i.name), i.data)
        await fetchAll(files)
        total = ENTRY.length + rest.length + files.length
      } else {
        const items = await eventually(async () => { const l = await drive.list(folder.id); return l.complete && l.items.length && l.items }, 30000, 10)
        await fetchAll(items.filter((i) => ENTRY.includes(i.name)))
        entry = now() - t
        await fetchAll(items.filter((i) => !ENTRY.includes(i.name)))
        total = items.length
      }
      return { joined, entry, all: now() - t, files: total }
    },
    connections: () => sfs.hg._network?.swarm?.connections?.size ?? null,
    close: () => sfs.close()
  }
}
