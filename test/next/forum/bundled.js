// A forum shipped with its app (spec 020, HyperBrowser 015): the owner's build
// packs what a visitor would download of a public forum; a new install unpacks
// it with nobody online, reads it, and later gets new posts from peers as any
// visitor. A changed pack, or a forum that isn't public, is refused.

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const forum = require('./forum.js')
const { account } = require('./_setup.js')
const { tmpDir } = require('hypergraph/testing')
const { eventually, codeOf } = require('../helpers.js')

const titles = async (f) => (await forum.latest(f, 100)).map((p) => p.title).sort()

async function packed (t) {
  const a = await account(t, 'a')
  const fa = await forum.createForum(a, 'Shipped')
  await fa.makePublic()
  for (let i = 0; i < 5; i++) await forum.post(fa, 'Post ' + i, 'text '.repeat(i * 200))
  const folder = path.join(tmpDir(t, 'pack'), 'forums')
  await forum.packForums(a, [fa], folder)
  return { a, fa, folder }
}

test('a packed forum is read with nobody online, and new posts come from peers', { timeout: 120000 }, async (t) => {
  const { a, fa, folder } = await packed(t)
  const key = fa.key
  const dir = a.dir
  await a.close()

  const c = await account(t, 'c')
  const [fc] = await forum.unpackForums(c, folder)
  t.is(fc.key, key, 'the same forum: same key')
  t.ok(fc.isPublic)
  t.is((await titles(fc)).length, 5, 'every post at once, with the owner offline')
  t.is(fc.name, 'Shipped')
  t.ok(c.spaces().some((s) => s.key === key), 'kept, as after a join')

  const a2 = await account(t, 'a2', { dir })
  const fa2 = a2.space(key)
  await forum.post(fa2, 'After the build', '')
  t.ok(await eventually(async () => (await titles(fc)).includes('After the build'), 30000), 'a post made after packing arrives')
  await forum.post(fc, 'From the new install', '')
  t.ok(await eventually(async () => (await titles(fa2)).includes('From the new install'), 30000), 'and the new install posts as a visitor does')

  await forum.unpackForums(c, folder) // the same pack again (an older one now): nothing goes back
  t.ok((await titles(fc)).includes('After the build'), 'unpacking an older pack keeps the newer posts')
})

test('a changed pack is refused, and nothing of it is kept', { timeout: 120000 }, async (t) => {
  const { a, folder } = await packed(t)
  await a.close()
  const cores = path.join(folder, 'cores')
  for (const f of fs.readdirSync(cores, { recursive: true })) { // every stored byte flipped past the headers
    const file = path.join(cores, f)
    if (!fs.statSync(file).isFile() || fs.statSync(file).size < 64) continue
    const bytes = fs.readFileSync(file)
    for (let i = 32; i < bytes.length; i += 7) bytes[i] ^= 0xff
    fs.writeFileSync(file, bytes)
  }
  const c = await account(t, 'c')
  t.ok(['IMPORT_INVALID'].includes(await codeOf(forum.unpackForums(c, folder))), 'refused')
  t.is(c.spaces().length, 0, 'nothing kept')

  const list = path.join(folder, 'spaces.json') // a pack naming more blocks than it holds
  const { a: a3, folder: other } = await packed(t)
  await a3.close()
  const meta = JSON.parse(fs.readFileSync(path.join(other, 'spaces.json'), 'utf-8'))
  meta.spaces[0].cores[0].length += 5
  fs.writeFileSync(list, JSON.stringify(meta))
  fs.rmSync(cores, { recursive: true, force: true })
  fs.cpSync(path.join(other, 'cores'), cores, { recursive: true })
  const d = await account(t, 'd')
  t.is(await codeOf(d.importSpaces(folder, { timeout: 3000 })), 'IMPORT_INVALID', 'missing blocks: refused')
  t.is(d.spaces().length, 0, 'nothing kept')
})

test('only public forums are packed; no secret is', { timeout: 60000 }, async (t) => {
  const a = await account(t, 'a')
  const closed = await forum.createForum(a, 'Members only')
  t.is(await codeOf(forum.packForums(a, [closed], tmpDir(t, 'x'))), 'NOT_ALLOWED', "a forum that isn't public")
  const open = await forum.createForum(a, 'Open')
  await open.makePublic()
  const folder = tmpDir(t, 'pack')
  await forum.packForums(a, [open], folder)
  const meta = JSON.parse(fs.readFileSync(path.join(folder, 'spaces.json'), 'utf-8'))
  t.alike(meta.spaces.map((s) => s.key), [open.key], 'the forum asked for, nothing else')
  t.absent(fs.existsSync(path.join(folder, 'instance.json')), 'no identity')
  // white-box: the device's secret key, the recovery phrase
  const secrets = [a._identity.device.secretKey.subarray(0, 32), Buffer.from([].concat(await a.recoveryPhrase()).join(' '))].filter(Boolean)
  t.is(secrets.length, 2, 'secrets to look for')
  for (const f of fs.readdirSync(folder, { recursive: true })) {
    const file = path.join(folder, f)
    if (!fs.statSync(file).isFile()) continue
    const bytes = fs.readFileSync(file)
    for (const s of secrets) t.is(bytes.indexOf(s), -1, 'no secret key in ' + f)
  }
})
