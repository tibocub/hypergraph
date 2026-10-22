// Decision rights follow devices (story 4, research.md A8). Writers of the
// decision log are devices of members whose role has `decide` or `moderate`:
// a device claims its writer key (`writer/add`, signed on its identity's
// behalf); a device removal signed by the identity key (`device/remove`)
// takes its keys away. Settlers (Autobase indexers) are one device per member
// with `decide`. Applied to an in-memory view, the way every member applies
// them.

const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const { applyNodes, initProof, removalSignable } = require('../../../lib/decisions/apply.js')
const { State } = require('../../../lib/decisions/state.js')
const { Identity } = require('../../../lib/identity.js')
const enc = require('../../../lib/encodings.js')

const hex = (b) => b4a.toString(b, 'hex')
const cutList = c.array(enc.struct([['log', c.fixed32], ['length', c.uint]]))

function memoryView () {
  const map = new Map()
  return {
    map,
    async get (key) { return map.has(key) ? { key, value: map.get(key) } : null },
    async put (key, value) { map.set(key, value) },
    async del (key) { map.delete(key) },
    dump () { return JSON.stringify([...map].sort()) }
  }
}

// Autobase's side, as far as apply sees it: writers, which of them settle,
// and its refusal to remove the last settler.
function memoryHost (first) {
  const writers = new Map([[hex(first), true]])
  return {
    writers,
    settlers () { return [...writers].filter(([, i]) => i).map(([k]) => k).sort() },
    async addWriter (key, { indexer = true } = {}) { writers.set(hex(key), indexer) },
    removeable (key) { return this.settlers().length !== 1 || this.settlers()[0] !== hex(key) },
    async removeWriter (key) {
      if (!this.removeable(key)) throw new Error('Not allowed to remove the last indexer')
      writers.delete(hex(key))
    }
  }
}

// One person: an identity and its devices, each with a writer key of its own.
async function person () {
  const first = await Identity.create({ device: crypto.keyPair() })
  const phrase = first.recoveryPhrase
  const secrets = await Identity.secrets(phrase)
  const devices = [first]
  const device = async () => {
    const d = await Identity.create({ device: crypto.keyPair(), mnemonic: phrase })
    devices.push(d)
    return d
  }
  return { identity: first.publicKey, first, devices, device, secrets }
}

async function space () {
  const owner = await person()
  const key = crypto.randomBytes(32)
  const view = memoryView()
  const host = memoryHost(key)
  let stamp = 1
  const apply = async (writer, d) => {
    await applyNodes([{ from: { key: writer }, value: c.encode(enc.decision, { stamp: stamp++, ...d }) }], view, host, { space: key })
    return State.from(view.map)
  }
  await apply(key, { type: 'space/init', name: 'F', parent: null, private: false, policy: 'auto', version: 1, proof: initProof(owner.first, key, key) })
  const claim = (device, writer = crypto.randomBytes(32)) => ({ writer, decision: { type: 'writer/add', key: writer, proof: initProof(device, writer, key) } })
  const removal = (who, device, cut = []) => {
    const bytes = c.encode(cutList, cut)
    return { type: 'device/remove', device: device.device.publicKey, cut: bytes, proof: Identity.attestAsIdentity(removalSignable(key, device.device.publicKey, bytes), who.secrets.keyPair) }
  }
  // Someone let in by the owner (a member until given another role).
  const join = async (p) => {
    await apply(key, { type: 'member/add', identity: p.identity })
    return p
  }
  return { owner, key, view, host, apply, claim, removal, join, state: () => State.from(view.map) }
}

test('an owner\'s second device claims its writer key; a plain member\'s claim is ignored', async (t) => {
  const s = await space()
  const phone = await s.owner.device()
  const { writer, decision } = s.claim(phone)
  let st = await s.apply(s.key, decision)
  t.is(st.identityOfWriter(writer), hex(s.owner.identity), 'the phone writes decisions for the owner')
  t.is(s.host.writers.get(hex(writer)), false, 'a writer, not a second settler (one per person)')
  st = await s.apply(writer, { type: 'role/define', name: 'helper', permissions: ['post'] })
  t.ok(st.roles.has('helper'), 'its decisions count')

  const m = await s.join(await person())
  const mine = s.claim(m.first)
  st = await s.apply(s.key, mine.decision)
  t.is(st.identityOfWriter(mine.writer), null, 'a member without decide or moderate writes no decisions')
  t.absent(s.host.writers.has(hex(mine.writer)))

  const again = await s.apply(s.key, decision)
  t.is(again.toJSON().writers.length, st.toJSON().writers.length, 'a claim counts once')
})

test('a forged claim, or one for someone who is not in, is ignored', async (t) => {
  const s = await space()
  const phone = await s.owner.device()
  const writer = crypto.randomBytes(32)
  const other = crypto.randomBytes(32)
  let st = await s.apply(s.key, { type: 'writer/add', key: writer, proof: initProof(phone, other, s.key) })
  t.is(st.identityOfWriter(writer), null, 'a proof for another key')
  st = await s.apply(s.key, { type: 'writer/add', key: writer, proof: initProof(phone, writer, crypto.randomBytes(32)) })
  t.is(st.identityOfWriter(writer), null, 'a proof for another space')
  const stranger = await person()
  st = await s.apply(s.key, s.claim(stranger.first).decision)
  t.is(st.toJSON().writers.length, 1, 'a stranger\'s claim')
})

test('a removed device loses its writer keys: its later decisions and claims are ignored', async (t) => {
  const s = await space()
  const phone = await s.owner.device()
  const { writer } = s.claim(phone)
  await s.apply(s.key, s.claim(phone, writer).decision)
  const m = await s.join(await person())

  let st = await s.apply(s.key, s.removal(s.owner, phone))
  t.is(st.identityOfWriter(writer), null, 'its key no longer speaks for the owner')
  t.absent(s.host.writers.has(hex(writer)), 'and is no longer a writer of the log')
  t.ok(st.isGone(s.owner.identity, phone.device.publicKey))
  st = await s.apply(writer, { type: 'moderate', action: 'ban', target: m.identity, reason: '', cut: [] })
  t.ok(st.isMember(m.identity), 'a ban it writes afterwards is ignored')
  st = await s.apply(s.key, s.claim(phone).decision)
  t.is(st.toJSON().writers.length, 1, 'a new claim from it is refused')
})

test('only the identity\'s own key removes its devices', async (t) => {
  const s = await space()
  const phone = await s.owner.device()
  const { writer, decision } = s.claim(phone)
  await s.apply(s.key, decision)
  const other = await s.join(await person())
  let st = await s.apply(s.key, s.removal(other, phone))
  t.is(st.identityOfWriter(writer), hex(s.owner.identity), 'someone else\'s key: ignored')
  const bytes = c.encode(cutList, [])
  const byDevice = { type: 'device/remove', device: phone.device.publicKey, cut: bytes, proof: s.owner.first.attest(removalSignable(s.key, phone.device.publicKey, bytes)) }
  st = await s.apply(s.key, byDevice)
  t.is(st.identityOfWriter(writer), hex(s.owner.identity), 'signed by another device, not the identity key: ignored')
})

test('losing decide and moderate drops a member\'s writer keys; a moderator writes but does not settle', async (t) => {
  const s = await space()
  const b = await s.join(await person())
  const bPhone = await b.device()
  let st = await s.apply(s.key, { type: 'role/set', identity: b.identity, role: 'admin', cut: [] })
  const first = s.claim(b.first)
  const second = s.claim(bPhone)
  await s.apply(s.key, first.decision)
  st = await s.apply(s.key, second.decision)
  t.is(st.identityOfWriter(second.writer), hex(b.identity))
  t.alike(s.host.settlers(), [hex(s.key), hex(first.writer)].sort(), 'settlers: the owner and one device of the admin')

  st = await s.apply(s.key, { type: 'role/set', identity: b.identity, role: 'moderator', cut: [] })
  t.alike(s.host.settlers(), [hex(s.key)], 'a moderator does not settle')
  t.is(s.host.writers.get(hex(first.writer)), false, 'but still writes')
  t.is(st.identityOfWriter(first.writer), hex(b.identity))

  st = await s.apply(s.key, { type: 'role/set', identity: b.identity, role: 'member', cut: [] })
  t.is(st.identityOfWriter(first.writer), null, 'a member writes no decisions')
  t.absent(s.host.writers.has(hex(first.writer)))
  t.absent(s.host.writers.has(hex(second.writer)))

  st = await s.apply(s.key, { type: 'role/set', identity: b.identity, role: 'admin', cut: [] })
  await s.apply(s.key, s.claim(bPhone, second.writer).decision)
  t.is(s.state().identityOfWriter(second.writer), hex(b.identity), 'promoted again, a device claims again')
  t.alike(s.host.settlers(), [hex(s.key), hex(second.writer)].sort())
})

test('a removed settling device hands settling over to another device of the same person', async (t) => {
  const s = await space()
  const b = await s.join(await person())
  const bPhone = await b.device()
  await s.apply(s.key, { type: 'role/set', identity: b.identity, role: 'admin', cut: [] })
  const first = s.claim(b.first)
  const second = s.claim(bPhone)
  await s.apply(s.key, first.decision)
  await s.apply(s.key, second.decision)
  await s.apply(s.key, s.removal(b, b.first))
  t.alike(s.host.settlers(), [hex(s.key), hex(second.writer)].sort(), 'the phone settles now')
})

test('the last settler stays one for Autobase, but its decisions no longer count', async (t) => {
  const s = await space()
  const phone = await s.owner.device()
  const { writer, decision } = s.claim(phone)
  await s.apply(s.key, decision)
  const m = await s.join(await person())
  // The owner's first device (the space's first writer and only settler) is lost.
  let st = await s.apply(writer, s.removal(s.owner, s.owner.first))
  t.alike(s.host.settlers(), [hex(writer)], 'the phone takes over settling')
  t.absent(s.host.writers.has(hex(s.key)))
  st = await s.apply(s.key, { type: 'moderate', action: 'ban', target: m.identity, reason: '', cut: [] })
  t.ok(st.isMember(m.identity), 'the lost device\'s ban is ignored')

  const solo = await space()
  const n = await solo.join(await person())
  st = await solo.apply(solo.key, solo.removal(solo.owner, solo.owner.first))
  t.ok(solo.host.writers.has(hex(solo.key)), 'with no other device, Autobase keeps its only settler')
  st = await solo.apply(solo.key, { type: 'moderate', action: 'ban', target: n.identity, reason: '', cut: [] })
  t.ok(st.isMember(n.identity), 'but nothing it decides counts')
})

test('a claim and a removal of the same device converge in either order', async (t) => {
  const make = async () => {
    const s = await space()
    const phone = await s.owner.device()
    return { s, phone }
  }
  const a = await make()
  const claim = a.s.claim(a.phone)
  const removal = a.s.removal(a.s.owner, a.phone)
  await a.s.apply(a.s.key, claim.decision)
  await a.s.apply(a.s.key, removal)

  // The same decisions applied the other way round, on another member.
  const view = memoryView()
  const host = memoryHost(a.s.key)
  let stamp = 1
  const apply = (writer, d) => applyNodes([{ from: { key: writer }, value: c.encode(enc.decision, { stamp: stamp++, ...d }) }], view, host, { space: a.s.key })
  await apply(a.s.key, { type: 'space/init', name: 'F', parent: null, private: false, policy: 'auto', version: 1, proof: initProof(a.s.owner.first, a.s.key, a.s.key) })
  await apply(a.s.key, removal)
  await apply(a.s.key, claim.decision)
  const one = State.from(a.s.view.map)
  const two = State.from(view.map)
  t.alike(one.toJSON().writers, two.toJSON().writers, 'the same writers')
  t.is(one.identityOfWriter(claim.writer), null)
})
