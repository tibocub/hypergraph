// Circles. The decisions a circle adds (marked at creation, 50
// members at most, only the owner and admins invite) and the holding logic
// that needs no network: what a member hands, in which order, within its
// cap, and what a holder deletes when people leave.

const test = require('brittle')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const { applyNodes, initProof } = require('../../../lib/decisions/apply.js')
const { State } = require('../../../lib/decisions/state.js')
const { Identity } = require('../../../lib/identity.js')
const invites = require('../../../lib/invites.js')
const enc = require('../../../lib/encodings.js')
const { plan, uncovered, MAX_MEMBERS } = require('../../../lib/circles.js')

function memoryView () {
  const map = new Map()
  return {
    map,
    async get (key) { return map.has(key) ? { key, value: map.get(key) } : null },
    async put (key, value) { map.set(key, value) },
    async del (key) { map.delete(key) },
    async * createReadStream ({ gte, lt } = {}) {
      for (const key of [...map.keys()].sort()) if ((!gte || key >= gte) && (!lt || key < lt)) yield { key, value: map.get(key) }
    }
  }
}

const host = { async addWriter () {}, removeable () { return true }, async removeWriter () {} }

async function circle ({ circle = true } = {}) {
  const owner = await Identity.create({ device: crypto.keyPair() })
  const key = crypto.randomBytes(32)
  const view = memoryView()
  let stamp = 1000
  const apply = async (writer, d) => {
    await applyNodes([{ from: { key: writer }, value: c.encode(enc.decision, { stamp: stamp++, ...d }) }], view, host, { space: key })
    return State.from(view.map)
  }
  await apply(key, { type: 'space/init', name: 'C', parent: null, private: true, policy: 'auto', version: 1, proof: initProof(owner, key, key), circle })
  const person = async () => {
    const identity = await Identity.create({ device: crypto.keyPair() })
    return { identity, writer: crypto.randomBytes(32), publicKey: identity.publicKey }
  }
  const invite = (maker, opts = {}) => invites.makeInvite({ space: key, role: 'member', uses: 0, expires: 0, ...opts }, maker)
  const redeem = (inv, who) => apply(key, { type: 'invite/redeem', redemption: c.encode(enc.redemption, invites.makeRedemption(inv, who.identity, who.writer)) })
  return { owner, key, apply, person, invite, redeem, state: () => State.from(view.map) }
}

test('a circle is marked at creation; a space that is not stays not', async (t) => {
  t.ok((await circle()).state().circle, 'a circle')
  t.absent((await circle({ circle: false })).state().circle, 'a plain private space')
})

test('a circle holds 50: the 51st is refused CIRCLE_FULL; a member redeeming again still counts once', async (t) => {
  t.is(MAX_MEMBERS, 50)
  const s = await circle()
  const inv = s.invite(s.owner)
  const people = []
  for (let i = 0; i < 49; i++) { // the owner is the first
    const p = await s.person()
    people.push(p)
    await s.redeem(inv, p)
  }
  let st = s.state()
  t.is(st.members.size, 50, '50 members')
  const late = await s.person()
  t.is(st.inviteRefusal(inv, late.publicKey, Date.now(), 49), 'CIRCLE_FULL', 'told why before recording')
  st = await s.redeem(inv, late)
  t.absent(st.isMember(late.publicKey), 'not recorded')
  t.is(st.members.size, 50)
  t.is(st.inviteRefusal(inv, people[0].publicKey, Date.now(), 49), null, 'a member again is not refused')

  const plain = await circle({ circle: false })
  const pinv = plain.invite(plain.owner)
  for (let i = 0; i < 50; i++) await plain.redeem(pinv, await plain.person())
  t.is(plain.state().members.size, 51, 'a space that is not a circle has no such limit')
})

test('in a circle only the owner and admins invite: a role given `invite` lets no one in', async (t) => {
  const s = await circle()
  await s.apply(s.key, { type: 'role/define', name: 'friend', permissions: ['post', 'invite'] })
  const f = await s.person()
  await s.redeem(s.invite(s.owner, { role: 'friend' }), f)
  t.is(s.state().roleOf(f.publicKey), 'friend')
  const inv = s.invite(f.identity)
  const d = await s.person()
  t.is(s.state().inviteRefusal(inv, d.publicKey, Date.now(), 0), 'NOT_ALLOWED')
  t.absent((await s.redeem(inv, d)).isMember(d.publicKey), 'not recorded')

  const a = await s.person()
  await s.redeem(s.invite(s.owner, { role: 'admin' }), a)
  const e = await s.person()
  t.ok((await s.redeem(s.invite(a.identity), e)).isMember(e.publicKey), 'an admin\'s invite works')
})

test('handing order: private first, then the rest, newest activity first; the member cap keeps the newest', (t) => {
  const MB = 1e6
  const spaces = [
    { key: 'old-public', private: false, activity: 1, bytes: 10 * MB },
    { key: 'new-public', private: false, activity: 9, bytes: 10 * MB },
    { key: 'old-private', private: true, activity: 2, bytes: 10 * MB },
    { key: 'new-private', private: true, activity: 8, bytes: 10 * MB }
  ]
  const all = plan(spaces, 200 * MB)
  t.alike(all.hand.map((s) => s.key), ['new-private', 'old-private', 'new-public', 'old-public'])
  t.alike(all.skip, [])
  const some = plan(spaces, 25 * MB)
  t.alike(some.hand.map((s) => s.key), ['new-private', 'old-private'], 'past the cap: the rest waits')
  t.alike(some.skip.map((s) => s.key), ['new-public', 'old-public'])
  t.alike(plan(spaces, 5 * MB).hand, [], 'one space bigger than the cap is not handed in part')
})

test('leaving: a holder deletes a member\'s cores unless another shared circle covers them', (t) => {
  // held: core -> who handed it; covered: members still sharing a circle with this holder
  const held = new Map([
    ['x', new Set(['ann'])],
    ['y', new Set(['ann', 'bob'])], // a space both are in
    ['z', new Set(['bob'])]
  ])
  t.alike(uncovered(held, new Set(['ann', 'bob'])), [], 'both still covered')
  t.alike(uncovered(held, new Set(['bob'])), ['x'], 'ann gone: only what bob did not hand too')
  t.alike([...held.get('y')], ['bob'], 'y now held for bob only')
  t.absent(held.has('x'), 'x forgotten')
  t.alike(uncovered(held, new Set()), ['y', 'z'], 'nobody left: everything')
  t.is(held.size, 0)
})
