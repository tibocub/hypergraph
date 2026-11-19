// A private space is encrypted on disk (its disk key, as the
// personal space's): whoever holds its cores without the key sees keys,
// lengths and sizes only. Closed and public spaces are as before. The key is
// never in an invite link (a commitment to it is). rotateKey() changes the
// content key by hand. The sessions that open its cores without the key
// (catchUp, exportSpaces, leaveSpace) never read a block as data.

const test = require('brittle')
const b4a = require('b4a')
const z32 = require('z32')
const { Hypergraph } = require('../../../lib/index.js')
const testing = require('../../../lib/testing.js')
const { tmpDir, codeOf } = require('../helpers.js')

const types = { post: { fields: { title: 'string', text: 'text' } } }

async function open (t, dir, opts = {}) {
  const hg = await Hypergraph.open(dir, { types, ...opts })
  t.teardown(() => hg.close(), { order: 0 })
  return hg
}

const rawBlocks = async (hg, space) => testing.rawBlocks(hg.store, await testing.coreKeys(space))
const shows = testing.inClear

test('a private space\'s cores hold no plaintext: no name, type, field or member key in any block', async (t) => {
  const hg = await open(t, tmpDir(t))
  const space = await hg.createSpace({ name: 'secret-name-7781', private: true })
  await space.put('post', { title: 'hush-title-7781', text: 'hush-text-7781' })
  t.is(space.name, 'secret-name-7781', 'the member reads its name')
  t.is((await space.query('post').latest(5)).items[0].title, 'hush-title-7781', 'and its records')
  t.ok(testing.diskKey(space), 'it has a disk key')

  const blocks = await rawBlocks(hg, space)
  t.ok(blocks.length > 5, 'blocks are held')
  for (const needle of ['secret-name-7781', 'hush-title-7781', 'hush-text-7781', 'space/init', 'post']) t.absent(shows(blocks, needle), `no "${needle}"`)
  t.absent(shows(blocks, z32.decode(hg.identity.publicKey)), 'no member key')
  t.absent(shows(blocks, space.keyBytes), 'no space key (log headers)')
})

test('closed and public spaces are as before: in the clear on disk, no disk key, links unchanged', async (t) => {
  const hg = await open(t, tmpDir(t))
  const closed = await hg.createSpace({ name: 'plain-name-5512' })
  await closed.put('post', { title: 'plain-title-5512', text: '' })
  t.absent(testing.diskKey(closed), 'no disk key')
  t.ok(shows(await rawBlocks(hg, closed), 'plain-name-5512'), 'its name is in the clear (as before)')
  t.ok(shows(await rawBlocks(hg, closed), 'plain-title-5512'), 'and its records')
  const sealed = await hg.createSpace({ name: 's', private: true })
  const a = z32.decode((await closed.createInvite()).slice(3))
  const b = z32.decode((await sealed.createInvite()).slice(3))
  t.is(b.byteLength - a.byteLength, 16, 'a sealed space\'s link is 16 bytes longer (the commitment)')
  await closed.makePublic()
  t.absent(testing.diskKey(closed), 'a public space: none either')
  t.absent(testing.diskKey(hg.personal) === testing.diskKey(sealed), 'the personal space keeps its own key')
})

test('the disk key is never in an invite link', async (t) => {
  const hg = await open(t, tmpDir(t))
  const space = await hg.createSpace({ name: 's', private: true })
  const key = testing.diskKey(space)
  for (const opts of [{}, { role: 'moderator' }, { uses: Infinity }]) {
    const bytes = z32.decode((await space.createInvite(opts)).slice(3))
    t.absent(b4a.includes(bytes, key), `not in ${JSON.stringify(opts)}'s link`)
  }
  const sub = await space.createSubspace({ name: 'sub' })
  t.alike(testing.diskKey(sub), key, 'a sub-space uses its top space\'s key')
  t.absent(b4a.includes(z32.decode((await sub.createInvite({ role: 'guest' })).slice(3)), key), 'nor in a sub-space\'s')
  t.is(await codeOf(sub.makePublic()), 'NOT_ALLOWED', 'its sub-spaces may not be made public (no key for public joiners)')
})

test('after a restart a private space opens with its key: readable, writable', async (t) => {
  const dir = tmpDir(t)
  let hg = await Hypergraph.open(dir, { types })
  const space = await hg.createSpace({ name: 'kept-7781', private: true })
  await space.put('post', { title: 'before', text: '' })
  const key = space.key
  await hg.close()
  hg = await open(t, dir)
  const again = hg.space(key)
  await again.ready()
  t.is(again.name, 'kept-7781')
  t.ok(await eventuallyTitle(again, 'before'), 'reads what was written')
  await again.put('post', { title: 'after', text: '' })
  t.ok(await eventuallyTitle(again, 'after'), 'and writes')
  t.absent(shows(await rawBlocks(hg, again), 'after'), 'still sealed on disk')
})

async function eventuallyTitle (space, title) {
  for (let i = 0; i < 50; i++) {
    if ((await space.query('post').latest(20)).items.some((p) => p.title === title)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

test('rotateKey(): the owner changes the content key; a space that isn\'t private refuses', async (t) => {
  const hg = await open(t, tmpDir(t))
  const space = await hg.createSpace({ name: 's', private: true })
  const before = space.state.keys.current
  await space.rotateKey()
  t.is(space.state.keys.current, before + 1, 'a new epoch, recorded when it resolves')
  await space.put('post', { title: 'with the new key', text: '' })
  t.ok(await eventuallyTitle(space, 'with the new key'), 'written and read with it')
  const closed = await hg.createSpace({ name: 'c' })
  t.is(await codeOf(closed.rotateKey()), 'NOT_ALLOWED', 'a closed space has no content key')
  t.is(await codeOf(hg.personal.rotateKey()), 'NOT_ALLOWED', 'nor the personal space')
})

test('key-free sessions on a private space read no block as data: catchUp, exportSpaces, leaveSpace', async (t) => {
  const hg = await open(t, tmpDir(t))
  const space = await hg.createSpace({ name: 'kf', private: true })
  await space.put('post', { title: 'kf-title', text: '' })
  const decisions = JSON.stringify([...space.state.writerInfo.keys()])
  await space.decisionLog.catchUp(500) // writers' cores keyless: lengths only
  t.is(JSON.stringify([...space.state.writerInfo.keys()]), decisions, 'catchUp leaves the state as it was')
  t.is(space.name, 'kf')
  t.is(await codeOf(hg.exportSpaces([space.key], tmpDir(t, 'pack'))), 'NOT_ALLOWED', 'exportSpaces refuses it (not public)')
  const own = space.own.key
  await hg.leaveSpace(space.key)
  const core = hg.store.get({ key: own })
  await core.ready()
  t.ok(core.length > 1, 'its log keeps its length')
  t.absent(await core.has(1), 'leaveSpace cleared its blocks (keyless)')
  await core.close()
})
