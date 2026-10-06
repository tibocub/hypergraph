// v2 prototype: rosters kept by keepers (spec 007, research R3).

const test = require('brittle')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { member, link, until } = require('./_helpers')
const { rosterSignable } = require('../../../src/v2/encodings')
const { segmentOf } = require('../../../src/v2/segments')

// An owner who keeps the channel, and an author who joins by key.
async function setup (t, label) {
  const owner = await member(t, `${label}-owner`)
  const channel = await owner.community.createChannel({ name: 'general', segmentMs: 60000 })
  await owner.community.keep(channel)
  const author = await member(t, `${label}-author`, { key: owner.community.key })
  t.teardown(link(owner, author))
  await until(async () => { await author.community.update(); return author.community.keepers(channel).length === 1 })
  return { owner, author, channel }
}

const listed = async (peer, channel, who, segment) =>
  (await peer.community.rosterEntries(channel, segment)).filter(e => e.author === who.pub)

test('v2 roster: an author is listed after its first post in a segment, once', async (t) => {
  const { owner, author, channel } = await setup(t, 'ros-list')
  const first = await author.community.post(channel, 'hello')
  const seg = segmentOf(first.t, 60000)
  t.ok(await until(async () => (await listed(owner, channel, author, seg)).length === 1), 'the keeper lists the author')
  await author.community.post(channel, 'again')
  await new Promise(resolve => setTimeout(resolve, 500))
  const entries = await listed(owner, channel, author, seg)
  t.is(entries.length, 1, 'a second post in the same segment adds nothing')
  t.is(entries[0].start, first.seq, 'the entry starts at the first post')
  t.ok(await until(async () => (await listed(author, channel, author, seg)).length === 1), 'and the author reads it too')
})

test('v2 roster: a keeper refuses bad signatures, banned authors and old segments', async (t) => {
  const { owner, author, channel } = await setup(t, 'ros-refuse')
  const keeper = owner.community
  const now = Date.now()
  const seg = segmentOf(now, 60000)
  const log = b4a.alloc(32, 5)
  const sign = (kp, segment) => crypto.sign(rosterSignable(keeper.key, channel, segment, log, 0), kp.secretKey)
  const stranger = crypto.keyPair()

  // Bad signature: signed by someone else than the claimed author.
  t.absent(await keeper.acceptAnnouncement({ channel, segment: seg, author: author.identity.keyPair.publicKey, log, start: 0, sig: sign(stranger, seg) }), 'bad signature refused')
  // Old segment.
  t.absent(await keeper.acceptAnnouncement({ channel, segment: seg - 5, author: stranger.publicKey, log, start: 0, sig: sign(stranger, seg - 5) }), 'old segment refused')
  // Banned.
  await keeper.ban(stranger.publicKey)
  t.absent(await keeper.acceptAnnouncement({ channel, segment: seg, author: stranger.publicKey, log, start: 0, sig: sign(stranger, seg) }), 'banned author refused')
  // Valid.
  const ok = crypto.keyPair()
  t.ok(await keeper.acceptAnnouncement({ channel, segment: seg, author: ok.publicKey, log, start: 0, sig: crypto.sign(rosterSignable(keeper.key, channel, seg, log, 0), ok.secretKey) }), 'a valid one is accepted')
})

test('v2 roster: readers merge two keepers and reject entries a keeper forged', async (t) => {
  const { owner, author, channel } = await setup(t, 'ros-merge')
  // A second keeper.
  const second = await member(t, 'ros-merge-k2', { key: owner.community.key })
  t.teardown(link(owner, second))
  t.teardown(link(second, author))
  await owner.community.setRole(second.pub, 'keeper', { writer: second.community.localKey })
  await until(async () => { await second.community.update(); return second.community.role(second.pub) === 'keeper' && second.community.control.writable })
  await second.community.keep(channel)
  await until(async () => { await author.community.update(); return author.community.keepers(channel).length === 2 })

  const post = await author.community.post(channel, 'hi both')
  const seg = segmentOf(post.t, 60000)
  t.ok(await until(async () => {
    await owner.community.update()
    return (await owner.community.rosterEntries(channel, seg, { keeper: second.pub })).some(e => e.author === author.pub)
  }), 'the second keeper lists the author too')

  // The second keeper forges an entry for someone who never posted.
  const victim = crypto.keyPair()
  await second.community.writeRosterEntryUnchecked(channel, seg, { author: victim.publicKey, log: b4a.alloc(32, 7), start: 0, sig: b4a.alloc(64, 1) })
  await new Promise(resolve => setTimeout(resolve, 500))
  const entries = await owner.community.rosterEntries(channel, seg)
  t.ok(entries.some(e => e.author === author.pub), 'the real author is listed (union)')
  t.absent(entries.some(e => e.author === victim.publicKey.toString('hex')), 'the forged entry is rejected')
  t.is(entries.filter(e => e.author === author.pub).length, 1, 'once, though both keepers list it')
})
