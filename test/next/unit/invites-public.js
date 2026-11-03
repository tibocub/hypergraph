// The public link (spec 016, research R5): `hg:` + z32(space key [+ root]),
// the same for everyone, told apart from an invite link by its length.

const test = require('brittle')
const b4a = require('b4a')
const z32 = require('z32')
const crypto = require('hypercore-crypto')
const invites = require('../../../lib/invites.js')
const { Identity } = require('../../../lib/identity.js')

test('a public link is hg: + z32(space key), decoded as public', (t) => {
  const space = crypto.randomBytes(32)
  const link = invites.publicLink(space)
  t.is(link, 'hg:' + z32.encode(space))
  t.is(invites.publicLink(space), link, 'the same every time')
  const d = invites.decodeLink(link)
  t.is(d.public, true)
  t.ok(b4a.equals(d.space, space))
  t.ok(b4a.equals(d.root, space), 'a top space is its own root')
})

test('a sub-space\'s public link carries its top space', (t) => {
  const sub = crypto.randomBytes(32)
  const root = crypto.randomBytes(32)
  const d = invites.decodeLink(invites.publicLink(sub, root))
  t.is(d.public, true)
  t.ok(b4a.equals(d.space, sub))
  t.ok(b4a.equals(d.root, root))
  t.is(invites.publicLink(sub, sub), invites.publicLink(sub), 'root = space: a top space')
})

test('invite links still decode; other lengths are refused', async (t) => {
  const owner = await Identity.create({ device: crypto.keyPair() })
  const space = crypto.randomBytes(32)
  const inv = invites.makeInvite({ space }, owner)
  const d = invites.decodeLink(invites.encodeLink(inv))
  t.absent(d.public)
  t.ok(b4a.equals(d.id, inv.id))
  for (const n of [0, 16, 31, 33, 48, 63, 65]) {
    let code = null
    try { invites.decodeLink('hg:' + z32.encode(crypto.randomBytes(n))) } catch (err) { code = err.code }
    t.is(code, 'INVITE_INVALID', `${n} bytes`)
  }
})
