// The decision state is kept in place (lib/decisions/log.js): each change of
// the view is applied to it, and it is rebuilt from the whole view only on open
// and when Autobase reorders (truncates) the view. Whatever the decisions and
// their order, the state kept in place must equal a full rebuild of the view:
// three deciders on real Autobases make random decisions while cut off from
// each other (one stays away for several rounds), then meet again, so
// Autobase reorders what each had applied.

const test = require('brittle')
const c = require('compact-encoding')
const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const { Decisions } = require('../../../lib/decisions/log.js')
const { initProof } = require('../../../lib/decisions/apply.js')
const { State, touched } = require('../../../lib/decisions/state.js')
const { Identity } = require('../../../lib/identity.js')
const enc = require('../../../lib/encodings.js')
const { tmpDir, eventually } = require('../helpers.js')

// Every field of a state, sorted, sub-spaces' own states and effective states included.
function dump (st) {
  const sorted = (m) => [...m].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1))
  const own = (s) => ({
    meta: s.meta,
    epochs: s.epochs,
    members: sorted(s.members),
    writers: sorted(s.writers),
    writerInfo: sorted(s.writerInfo),
    gone: [...s.gone].sort(),
    revoked: sorted(s.revoked),
    cuts: sorted(s.cuts),
    admits: sorted(s.admits),
    editcuts: sorted(s.editcuts),
    roles: sorted(s.roles),
    banned: sorted(s.banned),
    moderated: sorted(s.moderated),
    subspaces: sorted(s.subspaces),
    listed: sorted(s.listed)
  })
  const out = own(st)
  out.scoped = sorted(st.scoped).map(([k, s]) => [k, own(s)])
  out.subs = [...st.subspaces.keys()].sort().map((k) => {
    const s = st.sub(k)
    return [k, { meta: s.meta, members: sorted(s.members), banned: sorted(s.banned), cuts: sorted(s.cuts), moderated: sorted(s.moderated) }]
  })
  return JSON.parse(JSON.stringify(out))
}

async function rebuilt (d) {
  const entries = []
  for await (const { key, value } of d.base.view.createReadStream({ lt: '~' })) entries.push([key, value])
  return State.from(entries)
}

async function same (t, d, label) {
  await d.reload()
  t.alike(dump(d.state), dump(await rebuilt(d)), label)
}

function link (a, b) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.pipe(s2).pipe(s1)
  s1.on('error', () => {})
  s2.on('error', () => {})
  return () => { s1.destroy(); s2.destroy() }
}

test('the state kept in place equals a full rebuild, through partitions and reorders', async (t) => {
  t.timeout(120000)
  let seed = 7
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const pick = (list) => list[rand(list.length)]

  const owner = await Identity.create({ device: crypto.keyPair() })
  const stores = [0, 1, 2].map((i) => new Corestore(tmpDir(t, 'inplace-' + i)))
  t.teardown(async () => { for (const s of stores) await s.close() }, { order: 0 })
  const a = new Decisions(stores[0], null, { identity: owner })
  t.teardown(() => a.close(), { order: -1 })
  await a.ready()
  await a.init({ name: 'Forum' })

  // Two admins on devices of their own: three deciders.
  const deciders = [a]
  const links = []
  for (const s of stores.slice(1)) {
    const who = await Identity.create({ device: crypto.keyPair() })
    const d = new Decisions(s, a.key, { identity: who })
    t.teardown(() => d.close(), { order: -1 })
    await d.ready()
    links.push(link(stores[0], s))
    await a.append({ type: 'member/add', identity: who.publicKey })
    await a.append({ type: 'role/set', identity: who.publicKey, role: 'admin', cut: [] })
    await a.append({ type: 'writer/add', key: d.localKey, proof: initProof(who, d.localKey, a.key) })
    t.ok(await eventually(async () => { await d.update(); return d.writable }, 10000), 'an admin device became a writer')
    deciders.push(d)
  }
  await a.append({ type: 'role/define', name: 'editor', permissions: ['post', 'edit-pages'] })
  const sub = crypto.randomBytes(32)
  await a.append({ type: 'subspace/create', key: sub, name: 'Sub', private: false, writeRoles: [] })

  const people = Array.from({ length: 12 }, () => crypto.randomBytes(32))
  const records = Array.from({ length: 6 }, () => c.encode(enc.recordId, { log: crypto.randomBytes(32), seq: 1 + rand(5) }))
  const cut = () => [{ log: crypto.randomBytes(32), length: rand(4) }]
  const random = () => {
    const p = pick(people)
    switch (rand(9)) {
      case 0: case 1: return { type: 'member/add', identity: p }
      case 2: return { type: 'member/remove', identity: p, cut: cut() }
      case 3: return { type: 'role/set', identity: p, role: pick(['moderator', 'member', 'editor', 'guest']), cut: cut() }
      case 4: return { type: 'moderate', action: pick(['flag', 'hide', 'reveal', 'remove']), target: pick(records), reason: '', cut: [] }
      case 5: return { type: 'moderate', action: pick(['ban', 'unban']), target: p, reason: 'x', cut: cut() }
      case 6: return { type: 'settings/set', policy: pick(['auto', 'everything']), writeLimit: null, rules: null, history: null, helpers: null }
      case 7: return { type: 'logs/list', logs: [{ space: a.key, log: crypto.randomBytes(32) }] }
      default: return { type: 'scoped', space: sub, decision: c.encode(enc.decision, { stamp: Date.now(), ...pick([{ type: 'member/add', identity: p }, { type: 'moderate', action: 'ban', target: p, reason: '', cut: [] }]) }) }
    }
  }

  const rebuildsBefore = deciders.map((d) => d.rebuilds)
  let away = null // the decider staying cut off for several rounds
  for (let round = 0; round < 6; round++) {
    for (const off of links) off()
    links.length = 0
    if (round === 1) away = deciders[2]
    if (round === 4) away = null
    for (let i = 0; i < 6; i++) {
      const d = pick(deciders)
      await d.append(random())
      await same(t, d, `round ${round}: in place = rebuilt, on the decider`)
    }
    // Meet again (all but the one away): Autobase orders the concurrent decisions.
    for (const s of stores.slice(1)) if (!away || s !== away.base.store) links.push(link(stores[0], s))
    const met = deciders.filter((d) => d !== away)
    t.ok(await eventually(async () => {
      for (const d of met) await d.update()
      const v = met.map((d) => d.base.view.version)
      return v.every((x) => x === v[0])
    }, 20000), `round ${round}: the deciders met`)
    for (const d of met) await same(t, d, `round ${round}: in place = rebuilt after meeting`)
  }
  for (const s of stores.slice(1)) links.push(link(stores[0], s))
  for (const d of deciders) await d.update()
  await eventually(async () => {
    for (const d of deciders) await d.update()
    const v = deciders.map((d) => JSON.stringify(dump(d.state)))
    return v.every((x) => x === v[0])
  }, 20000)
  for (const d of deciders) await same(t, d, 'at the end: in place = rebuilt')
  t.alike(dump(deciders[1].state), dump(deciders[0].state), 'the deciders agree')
  t.ok(deciders.some((d, i) => d.rebuilds > rebuildsBefore[i]), 'Autobase reordered at least once (a rebuild ran)')
  for (const off of links) off()
})

test('what a decision touches: hooks look only at those identities, records and logs', (t) => {
  const id = 'a'.repeat(64)
  const sub = 'b'.repeat(64)
  const plain = (x) => ({ all: x.all, ids: [...x.ids], mods: [...x.mods], listed: [...x.listed] })
  t.alike(plain(touched(null)), { all: true, ids: [], mods: [], listed: [] }, 'a full read: everything')
  t.alike(plain(touched(new Set([`member:${id}`, `redeemed:${'c'.repeat(32)}:${id}`, `uses:${'c'.repeat(32)}`]))), { all: false, ids: [id], mods: [], listed: [] }, 'a join: its identity only')
  t.alike(plain(touched(new Set([`sub:${sub}:banned:${id}`, `sub:${sub}:cut:${id}`]))), { all: false, ids: [id], mods: [], listed: [] }, 'a ban in a sub-space: its identity')
  t.alike(plain(touched(new Set(['mod:ff', 'listed:ee', 'writer:dd', 'gone:x:y', 'epochs']))), { all: false, ids: [], mods: ['ff'], listed: ['ee'] }, 'moderation and listed logs; writers, devices and keys touch none')
  t.ok(touched(new Set(['meta'])).all, 'settings: everything')
  t.ok(touched(new Set(['role:editor'])).all, 'a role defined: everything')
  t.ok(touched(new Set([`subspace:${sub}`])).all, 'a sub-space: everything')
})
