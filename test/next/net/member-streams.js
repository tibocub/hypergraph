// Member streams (SwarmFS's request S1): an app's own transfer library gets
// the connection streams of a space's proven members, as they connect and
// the current ones, and opens its own Protomux channel on them, next to
// hypergraph's. A non-member's stream is never handed out, even one that
// knows the space key.

const test = require('brittle')
const c = require('compact-encoding')
const Protomux = require('protomux')
const forum = require('../forum/_setup.js')
const f = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { eventually, sleep } = require('../helpers.js')

function collect (space) {
  const seen = []
  space.on('member-connection', (stream, peer) => seen.push({ stream, peer }))
  return seen
}

test('member streams: a member\'s is handed out, a non-member\'s never, until it is let in', async (t) => {
  const a = await forum.account(t, 'a')
  const b = await forum.account(t, 'b')
  const e = await forum.account(t, 'e')
  const fa = await f.createForum(a, 'Fans')
  const seen = collect(fa)
  const fb = await f.join(b, await f.invite(fa))
  t.ok(await eventually(() => seen.some((s) => s.peer.device === b.device.publicKey), 10000), 'b\'s stream is handed out')
  const fromB = seen.find((s) => s.peer.device === b.device.publicKey)
  t.is(fromB.peer.identity, b.identity.publicKey, 'with who it is')
  t.ok(fromB.stream.remotePublicKey && typeof fromB.stream.write === 'function', 'a connection stream')
  t.alike(fa.memberConnections().map((m) => m.device), [b.device.publicKey], 'listed with the current ones')

  const fe = await testing.openSpace(e, fa.key) // knows the key, isn't a member
  t.ok(await eventually(() => fa.peers().some((p) => p.identity === e.identity.publicKey), 10000), 'e is connected, its device proven')
  await sleep(500)
  t.absent(seen.some((s) => s.peer.device === e.device.publicKey), 'e\'s stream is never handed out')
  t.absent(fa.memberConnections().some((m) => m.device === e.device.publicKey), 'nor listed')

  await f.join(e, await f.invite(fa)) // e is let in
  t.ok(await eventually(() => seen.some((s) => s.peer.device === e.device.publicKey), 10000), 'once let in, its stream is handed out')
  t.is(seen.filter((s) => s.peer.device === b.device.publicKey).length, 1, 'each stream once')
  t.ok(fb && fe)
})

test('member streams: an app\'s own Protomux channel works next to hypergraph\'s', async (t) => {
  const { fa, fb } = await forum.threeMembers(t)
  const heard = { a: [], b: [] }
  const own = (space, label) => {
    const open = (stream) => {
      const mux = Protomux.from(stream) // the muxer hypergraph uses: Protomux keeps it on the stream
      const ch = mux.createChannel({ protocol: 'test/transfer', onopen: () => ch.messages[0].send('hi from ' + label) })
      if (!ch) return
      ch.addMessage({ encoding: c.string, onmessage: (m) => heard[label].push(m) })
      ch.open()
      mux.pair({ protocol: 'test/transfer' }, () => open(stream))
    }
    for (const m of space.memberConnections()) open(m.stream)
    space.on('member-connection', (stream) => open(stream))
  }
  own(fa, 'a')
  own(fb, 'b')
  t.ok(await eventually(() => heard.a.includes('hi from b') && heard.b.includes('hi from a'), 10000), 'the app\'s channel opens both ways')
  await f.post(fb, 'still syncing', '')
  t.ok(await eventually(async () => (await f.latest(fa)).some((p) => p.title === 'still syncing'), 10000), 'hypergraph still replicates on the same stream')
})

test('member streams: a removed member\'s stream is withdrawn once; a still-member keeps it in another space', async (t) => {
  const { a, c, fa, fc } = await forum.threeMembers(t)
  const other = await f.createForum(a, 'Other')
  await f.join(c, await f.invite(other)) // c shares a's connection in both spaces
  const gone = []
  fa.on('member-disconnection', (stream, peer) => gone.push({ stream, peer }))
  t.ok(await eventually(() => other.memberConnections().some((m) => m.device === c.device.publicKey), 10000), 'c is a member in the other space')
  t.ok(await eventually(() => fa.memberConnections().some((m) => m.device === c.device.publicKey), 10000), 'and in this one')
  await f.removeMember(fa, c.identity.publicKey)
  t.ok(await eventually(() => gone.some((g) => g.peer.device === c.device.publicKey), 10000), 'removal fires member-disconnection')
  await sleep(500)
  t.is(gone.length, 1, 'once')
  t.absent(fa.memberConnections().some((m) => m.device === c.device.publicKey), 'no longer listed here')
  t.ok(other.memberConnections().some((m) => m.device === c.device.publicKey), 'still listed in the other space')
  t.ok(fc)
})

test('member streams: a ban withdraws the stream; let back in, it is handed out again', async (t) => {
  const { c, fa } = await forum.threeMembers(t)
  const seen = collect(fa)
  const gone = []
  fa.on('member-disconnection', (stream, peer) => gone.push(peer))
  const isC = (p) => p.device === c.device.publicKey
  t.ok(await eventually(() => fa.memberConnections().some(isC), 10000), 'c is listed')
  const before = seen.length
  await f.ban(fa, c.identity.publicKey)
  t.ok(await eventually(() => gone.some(isC), 10000), 'a ban fires member-disconnection')
  await f.unban(fa, c.identity.publicKey)
  await f.giveRole(fa, c.identity.publicKey, 'member')
  t.ok(await eventually(() => seen.slice(before).some((s) => isC(s.peer)), 10000), 'let back in: member-connection again')
  t.is(gone.filter(isC).length, 1, 'one disconnection')
})

test('member streams: a removed device\'s stream is withdrawn', async (t) => {
  const { a, fa } = await forum.threeMembers(t)
  await f.protectPhrase(a, 'pw')
  const { code } = await f.addDevice(a, 'pw')
  const phone = await forum.device(t, 'a-phone', code)
  const shown = await eventually(() => f.forums(phone).some((x) => x.key === fa.key), 15000)
  t.ok(shown, 'the phone holds the forum')
  const gone = []
  const isPhone = (p) => p.device === phone.device.publicKey
  t.ok(await eventually(() => fa.memberConnections().some(isPhone), 15000), 'the phone\'s stream is a member\'s')
  fa.on('member-disconnection', (stream, peer) => gone.push(peer))
  await f.removeDevice(a, phone.device.publicKey, 'pw')
  t.ok(await eventually(() => gone.some(isPhone), 10000), 'device removal fires member-disconnection')
})
