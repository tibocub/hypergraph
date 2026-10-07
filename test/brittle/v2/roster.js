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

// The keeper's own roster core for a channel (its length counts the entries written).
async function rosterCore (peer, channel) {
  const { rosterKey } = peer.community.keepers(channel)[0]
  const core = peer.store.get({ key: b4a.from(rosterKey, 'hex') })
  await core.ready()
  return core
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

test('v2 roster: a keeper that restarts keeps listing in the same roster', async (t) => {
  // Reopening a community by key opens it in another storage namespace than
  // the one it was created in; a roster named in the namespace came back as
  // a new, empty roster under a key no reader knew (bench/v2-chat.js: every
  // live post after the host restarted was invisible).
  const { Community } = require('../../../src/v2')
  const owner = await member(t, 'ros-restart-owner')
  const channel = await owner.community.createChannel({ name: 'general', segmentMs: 60000 })
  await owner.community.keep(channel)
  const key = owner.community.key
  const rosterKey = owner.community.keepers(channel)[0].rosterKey
  await owner.community.close()

  const reopened = new Community(owner.store, { identity: owner.identity, key })
  await reopened.ready()
  t.teardown(() => reopened.close())
  const post = await reopened.post(channel, 'after a restart')
  t.is(reopened.keepers(channel)[0].rosterKey, rosterKey, 'the control log still names the original roster')

  // Another member reads the roster the control log names.
  const reader = await member(t, 'ros-restart-reader', { key })
  const s1 = reopened.replicate(true); const s2 = reader.community.replicate(false); s1.pipe(s2).pipe(s1)
  t.teardown(() => { s1.destroy(); s2.destroy() })
  t.ok(await until(async () => {
    await reader.community.update()
    return (await reader.community.rosterEntries(channel, segmentOf(post.t, 60000))).some(e => e.author === owner.pub)
  }), 'another member sees the post listed')
})

test('v2 roster: an announcement received many times at once is listed once', async (t) => {
  // 100 authors posting for the first time together: the keeper wrote 2,996
  // roster entries for 100 authors (copies of one announcement all passed
  // the "already listed?" check before the first was written). Each is a
  // permanent block, and a roster update for every reader.
  const owner = await member(t, 'ros-dup-owner')
  const channel = await owner.community.createChannel({ name: 'general', segmentMs: 60000 })
  await owner.community.keep(channel)
  const keeper = owner.community
  const seg = segmentOf(Date.now(), 60000)
  const roster = await rosterCore(owner, channel)
  const authors = Array.from({ length: 6 }, () => crypto.keyPair())
  const anns = authors.map((a) => {
    const log = crypto.randomBytes(32)
    return { channel, segment: seg, author: a.publicKey, log, start: 0, sig: crypto.sign(rosterSignable(keeper.key, channel, seg, log, 0), a.secretKey) }
  })
  await keeper.acceptAnnouncement(anns.shift()) // the first entry also writes the Hyperbee header
  const before = roster.length
  const copies = []
  for (let i = 0; i < 20; i++) for (const ann of anns) copies.push(keeper.acceptAnnouncement(ann))
  t.ok((await Promise.all(copies)).every(Boolean), 'every copy accepted')
  t.is(roster.length - before, anns.length, `${anns.length} entries written for ${copies.length} copies`)
})

test('v2 roster: an author announces a new segment once, not again with every pending one', async (t) => {
  // Each first post re-sent every announcement still pending: 10 first posts
  // with nobody listing them, 55 broadcasts. Retries are the timer's job.
  const { Roster } = require('../../../src/v2/roster')
  const owner = await member(t, 'ros-once-owner')
  const channel = await owner.community.createChannel({ name: 'general', segmentMs: 60000 })
  await owner.community.keep(channel)
  const author = await member(t, 'ros-once-author', { key: owner.community.key })
  const unlink = link(owner, author)
  await until(async () => { await author.community.update(); return author.community.keepers(channel).length === 1 })
  unlink() // the keeper goes away: nothing gets listed, everything stays pending
  // A peer that holds the roster and only counts what reaches it.
  const spy = await member(t, 'ros-once-spy', { key: owner.community.key })
  t.teardown(link(author, spy))
  let received = 0
  const roster = new Roster(spy.store.get({ key: b4a.from(author.community.keepers(channel)[0].rosterKey, 'hex') }), { onAnnouncement: async () => { received++ } })
  await roster.ready()
  t.teardown(() => roster.close())
  await author.community.rosterEntries(channel, 0) // the author opens the roster
  await until(() => roster.core.peers.length > 0, 5000)
  const identities = Array.from({ length: 10 }, () => ({ keyPair: crypto.keyPair(), seed: crypto.randomBytes(32) }))
  for (const id of identities) await author.community.postAs(id, channel, 'first')
  await until(() => received >= 10, 3000)
  t.ok(received >= 10 && received <= 20, `${received} announcements for 10 first posts`)
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
