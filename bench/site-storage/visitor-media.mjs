// Q3: a forum member posts an image into the site's SwarmFS space. What works with today's
// roles, what is missing. Three people in one process on a local DHT: Alice (the site's owner),
// Bob (a forum member, let in with SwarmFS's invite), Carol (another visitor).
//
//   node bench/site-storage/visitor-media.mjs
//
// Part A: SwarmFS as it is (one space, invitees are `editor`s).
// Part B: hypergraph's sub-spaces under SwarmFS: pages in a sub-space only admins write
//         (writeRoles), uploads in the top space. SwarmFS has no call for this: its Drive is
//         used on a sub-space key directly.

import fs from 'fs'
import path from 'path'
import { swarmfs, testnet, tmpDir, rm, siteFiles, writeSite, bytes, eventually, now } from './common.mjs'

const { SwarmFS } = await swarmfs()
const net = await testnet()
const base = tmpDir('media')
const open = []
const person = async (name) => {
  const sfs = await SwarmFS.open(path.join(base, name), { bootstrap: net.bootstrap, deviceName: name, minFree: 0, fetchTimeout: 5000 })
  await sfs.setName(name)
  open.push(sfs)
  return sfs
}
const code = async (p) => { try { await p; return 'ok' } catch (err) { return err.code || err.message } }
const report = (what, value) => console.log(`${what}: ${value}`)
const folderOf = (drive, name, parent = drive.top) => eventually(async () => (await drive.list(parent)).items.find((i) => i.name === name), 20000)

try {
  const alice = await person('alice')
  const bob = await person('bob')
  const carol = await person('carol')
  for (const d of ['carol-out', 'bob2-out']) fs.mkdirSync(path.join(base, d), { recursive: true })
  const siteDir = writeSite(path.join(base, 'disk-alice', 'site'), siteFiles({ images: 2 }))
  fs.mkdirSync(path.join(siteDir, 'uploads'))
  const img = (name, seed) => { const p = path.join(base, 'disk-bob', name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes(200 * 1024, seed)); return p }

  console.log('--- Part A: SwarmFS as it is')
  const site = await alice.createSpace('Site')
  const root = await site.add(siteDir)
  await alice.sync() // Alice's app keeps her site folder in step with the space (spec 002), as a running owner's would
  const ab =await bob.join(await site.invite())
  const bobRoot = await folderOf(ab, 'site')
  const uploads = await folderOf(ab, 'uploads', bobRoot.id)
  report('Bob\'s role after the invite', (await ab.members()).find((m) => m.you).role)
  const t = now()
  const photo = await code(ab.add(img('photo.jpg', 1), { parent: uploads.id }))
  report('Bob adds photo.jpg (200 KB) into uploads/', photo)
  const ac = await carol.join(await site.invite())
  const cu = await folderOf(ac, 'uploads', (await folderOf(ac, 'site')).id)
  const seen = await folderOf(ac, 'photo.jpg', cu.id)
  report('Carol sees it', seen ? `yes, ${Math.round(now() - t)} ms after Bob added it` : 'no')
  const t2 = now()
  report('Carol fetches it from Bob', `${await code(ac.fetch(seen.id, path.join(base, 'carol-out', 'photo.jpg')))} (${Math.round(now() - t2)} ms)`)

  const onDisk = (name) => eventually(() => fs.existsSync(path.join(siteDir, name)), 15000)
  report('Bob\'s photo lands in Alice\'s site folder on her disk (her app syncing)', (await onDisk('uploads/photo.jpg')) ? 'yes' : 'no')
  const index = await folderOf(ab, 'index.html', bobRoot.id)
  report('Bob renames the site\'s index.html', await code(ab.rename(index.id, 'defaced.html')))
  report('... and Alice\'s index.html on her disk is renamed too (her app syncing)', (await onDisk('defaced.html')) ? 'yes' : 'no')
  report('Bob moves page-1.html into uploads/', await code(ab.move((await folderOf(ab, 'page-1.html', bobRoot.id)).id, uploads.id)))
  report('Bob adds his own index.html at the site\'s root', await code(ab.add(img('index.html', 9), { parent: bobRoot.id })))
  report('Bob removes page-2.html (to the bin)', await code(ab.remove((await folderOf(ab, 'page-2.html', bobRoot.id)).id)))
  await ab.rename(index.id, 'index.html').catch(() => {})

  const late = await code(ab.add(img('late.jpg', 2), { parent: uploads.id }))
  const lateEntry = await folderOf(ac, 'late.jpg', cu.id)
  await bob.close()
  open.splice(open.indexOf(bob), 1)
  report('Bob adds late.jpg, then goes offline; Carol fetches it', `${late}, then ${await code(ac.fetch(lateEntry.id, path.join(base, 'carol-out', 'late.jpg')))}`)
  const aliceHas = await site.get(lateEntry.id)
  report('Alice\'s syncing app got late.jpg before Bob left (he left at once)',aliceHas.holders.some((h) => h.device === alice.device) ? 'yes' : 'no')
  report('A read-only invite in SwarmFS', typeof site.invite === 'function' ? 'no option: Drive.invite always gives `editor` (post)' : '?')
  report('A visitor without any invite reads the site', 'no call for it: SwarmFS spaces are private, SwarmFS.join takes an invite')
  void root

  console.log('--- Part B: pages in a sub-space only admins write (hypergraph writeRoles)')
  const bob2 = await person('bob2')
  const site2 = await alice.createSpace('Site 2')
  const pages = await site2.space.createSubspace({ name: 'pages', writeRoles: ['admin'] })
  const pagesDrive = alice.space(pages.key)
  report('Alice adds the site into the pages sub-space', await code(pagesDrive.add(writeSite(path.join(base, 'disk-alice', 'site2'), siteFiles({ images: 1 })))))
  const b2 = await bob2.join(await site2.invite())
  const bobPages = await eventually(() => { try { return bob2.space(pages.key) } catch { return null } }, 20000)
  report('Bob sees the pages sub-space', bobPages ? 'yes' : 'no')
  if (bobPages) {
    const bp = await folderOf(bobPages, 'site2')
    const bIndex = bp && await folderOf(bobPages, 'index.html', bp.id)
    report('Bob lists the pages', bIndex ? 'yes' : 'no')
    if (bIndex) {
      report('Bob fetches index.html from the pages sub-space', await code(bobPages.fetch(bIndex.id, path.join(base, 'bob2-out', 'index.html'))))
      report('Bob renames index.html in the pages sub-space', await code(bobPages.rename(bIndex.id, 'defaced.html')))
      report('Bob adds a file into the pages sub-space', await code(bobPages.add(img('evil.html', 5), { parent: bp.id })))
    }
  }
  report('Bob adds photo.jpg into the top space (uploads)', await code(b2.add(img('photo2.jpg', 3))))
  // the other side of writeRoles: Bob can still rename/move what others put in the top space
  const aliceUpload = await code(site2.add(img('alice.jpg', 4)))
  const aliceEntry = await folderOf(b2, 'alice.jpg')
  report('Bob renames a picture Alice put in uploads', `${aliceUpload}, ${await code(b2.rename(aliceEntry.id, 'mine.jpg'))}`)

  console.log('--- Part C: a read-only visitor (a role with no permissions, hypergraph calls)')
  const dave = await person('dave')
  report('Alice defines role "reader" with no permissions', await code(site2.space.defineRole('reader', [])))
  let link = null
  report('Alice makes a public reader link (uses: Infinity)', await code((async () => { link = await site2.space.createInvite({ role: 'reader', uses: Infinity }) })()))
  if (link) {
    const d = await dave.join(link)
    report('Dave\'s role', (await d.members()).find((m) => m.you).role)
    const dp = await eventually(() => { try { return dave.space(pages.key) } catch { return null } }, 20000)
    const dsite = dp && await folderOf(dp, 'site2')
    const dIndex = dsite && await folderOf(dp, 'index.html', dsite.id)
    fs.mkdirSync(path.join(base, 'dave-out'), { recursive: true })
    report('Dave fetches index.html', dIndex ? await code(dp.fetch(dIndex.id, path.join(base, 'dave-out', 'index.html'))) : 'pages not seen')
    report('Dave adds a picture', await code(d.add(img('dave.jpg', 6))))
    const anyFile = await eventually(async () => (await d.list(d.top)).items.find((i) => i.kind === 'file'), 20000)
    report('Dave renames a picture', anyFile ? await code(d.rename(anyFile.id, 'x.jpg')) : 'no file seen at the top')
    report('What Dave sees at the top', JSON.stringify((await d.list(d.top)).items.map((i) => i.name)) + ', access ' + d.space.status().access + ', private ' + d.space.private)
  }
} finally {
  for (const sfs of open) await sfs.close().catch(() => {})
  await net.destroy()
  await rm(base)
}
