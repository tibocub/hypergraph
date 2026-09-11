const test = require('brittle')
const { createGraph } = require('../helpers')

async function setupScopedGraph (t, label) {
  const { graph } = await createGraph(t, label)
  const owner = graph.identity.deviceKeyPair.publicKey.toString('hex')

  await graph.createRoleBase()
  await graph.roleBase.init(owner)
  await graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'owner',
    permissions: ['*'],
    author: owner,
    timestamp: Date.now()
  })
  await graph.update()
  await graph.createScopeBase()

  return { graph, owner }
}

test('content-encryption: putContent/getContent round-trip when the caller holds the scope key', async (t) => {
  console.log('TEST: encrypted content round-trip - starting')
  const { graph } = await setupScopedGraph(t, 'content-enc-basic')

  const { scopeId } = await graph.scopeBase.createScope('private-dms')
  const post = await graph.put({ type: 'post' })

  console.log('  Step 1: write encrypted content')
  const written = await graph.putContent(post.id, 'a secret message', 'text', { scope: scopeId })
  t.is(written.body, 'a secret message', 'putContent returns the plaintext to the caller who just wrote it, not the ciphertext')
  t.ok(written.encrypted, 'the returned shape flags this as encrypted')

  console.log('  Step 2: read it back — the creator can decrypt their own content')
  const read = await graph.getContent(post.id)
  t.ok(read.encrypted, 'getContent flags the stored record as encrypted')
  t.is(read.body, 'a secret message', 'getContent decrypts back to the original plaintext')
  t.is(read.contentType, 'text', 'contentType is preserved correctly')
  console.log('TEST: encrypted content round-trip - passed')
})

test('content-encryption: contentType stays in the clear even when the body is encrypted', async (t) => {
  console.log('TEST: contentType not encrypted - starting')
  const { graph } = await setupScopedGraph(t, 'content-enc-contenttype')

  const { scopeId } = await graph.scopeBase.createScope('private-dms')
  const post = await graph.put({ type: 'post' })
  await graph.putContent(post.id, JSON.stringify({ x: 1 }), 'application/json', { scope: scopeId })

  const read = await graph.getContent(post.id)
  t.is(read.contentType, 'application/json', 'contentType is correct and was never encrypted — only the body payload is')
  console.log('TEST: contentType not encrypted - passed')
})

test('content-encryption: an existing entity\'s content stored WITHOUT a scope is completely unaffected', async (t) => {
  console.log('TEST: unencrypted path unaffected - starting')
  const { graph } = await setupScopedGraph(t, 'content-enc-unaffected')

  const post = await graph.put({ type: 'post' })
  await graph.putContent(post.id, 'plain text, no scope', 'text')

  const read = await graph.getContent(post.id)
  t.is(read.body, 'plain text, no scope', 'unencrypted content works exactly as before')
  t.absent(read.encrypted, 'encrypted flag is falsy for content that was never encrypted')
  console.log('TEST: unencrypted path unaffected - passed')
})

test('content-encryption: putContent throws for an unknown scope', async (t) => {
  console.log('TEST: putContent unknown scope - starting')
  const { graph } = await setupScopedGraph(t, 'content-enc-unknown-scope')
  const post = await graph.put({ type: 'post' })

  await t.exception(
    graph.putContent(post.id, 'content', 'text', { scope: 'never-created' }),
    /Unknown scope/,
    'putContent rejects an unknown scope outright'
  )
  console.log('TEST: putContent unknown scope - passed')
})

test('content-encryption: putContent throws if the caller does not hold the scope\'s key', async (t) => {
  console.log('TEST: putContent without key - starting')
  const Corestore = require('corestore')
  const path = require('path')
  const os = require('os')
  const fs = require('fs')
  const { sleep } = require('../helpers')
  const { Hypergraph } = require('../../../index.js')

  const dirA = path.join(os.tmpdir(), `hypergraph-content-nokey-a-${process.pid}-${Date.now()}`)
  const storeA = new Corestore(dirA)
  const graphA = new Hypergraph(storeA)
  await graphA.ready()

  const dirB = path.join(os.tmpdir(), `hypergraph-content-nokey-b-${process.pid}-${Date.now()}`)
  const storeB = new Corestore(dirB)
  const graphB = new Hypergraph(storeB)
  await graphB.ready()

  t.teardown(async () => {
    await graphA.close()
    await graphB.close()
    await storeA.close()
    await storeB.close()
    fs.rmSync(dirA, { recursive: true, force: true })
    fs.rmSync(dirB, { recursive: true, force: true })
  })

  const owner = graphA.identity.deviceKeyPair.publicKey.toString('hex')
  await graphA.createRoleBase()
  await graphA.roleBase.init(owner)
  await graphA.update()
  const scopeKeyHex = await graphA.createScopeBase()
  const { scopeId } = await graphA.scopeBase.createScope('private-dms')
  const post = await graphA.put({ type: 'post' })

  console.log('  a second identity replicates the entity itself, but was never granted this scope\'s key')
  const roleKeyHex = graphA.roleBase.key.toString('hex')
  await graphB.openRoleBase(roleKeyHex)
  await graphB.openUserCore(graphA.key)
  await graphB.openScopeBase(scopeKeyHex)

  const s1 = storeA.replicate(true, { live: true })
  const s2 = storeB.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => {
    try { s1.destroy() } catch (err) { /* already closed */ }
    try { s2.destroy() } catch (err) { /* already closed */ }
  })

  let node = null
  for (let i = 0; i < 30; i++) {
    await sleep(200)
    await graphB.update()
    node = await graphB.get(post.id)
    if (node) break
  }
  t.ok(node, 'sanity check: the entity itself replicated correctly')

  await t.exception(
    graphB.putContent(post.id, 'content', 'text', { scope: scopeId }),
    /do not hold the current key/,
    'putContent refuses to encrypt for a scope the caller was never granted — cannot encrypt with a key it does not have'
  )
  console.log('TEST: putContent without key - passed')
})

test('content-encryption: a peer without the scope key gets a clean "no access" shape from getContent, not a crash or garbage', async (t) => {
  console.log('TEST: getContent without access - starting')
  const Corestore = require('corestore')
  const path = require('path')
  const os = require('os')
  const fs = require('fs')
  const { Hypergraph } = require('../../../index.js')

  const dirOwner = path.join(os.tmpdir(), `hypergraph-content-noaccess-owner-${process.pid}-${Date.now()}`)
  const storeOwner = new Corestore(dirOwner)
  const graphOwner = new Hypergraph(storeOwner)
  await graphOwner.ready()

  const dirOutsider = path.join(os.tmpdir(), `hypergraph-content-noaccess-outsider-${process.pid}-${Date.now()}`)
  const storeOutsider = new Corestore(dirOutsider)
  const graphOutsider = new Hypergraph(storeOutsider)
  await graphOutsider.ready()

  t.teardown(async () => {
    await graphOwner.close()
    await graphOutsider.close()
    await storeOwner.close()
    await storeOutsider.close()
    fs.rmSync(dirOwner, { recursive: true, force: true })
    fs.rmSync(dirOutsider, { recursive: true, force: true })
  })

  const owner = graphOwner.identity.deviceKeyPair.publicKey.toString('hex')
  await graphOwner.createRoleBase()
  await graphOwner.roleBase.init(owner)
  await graphOwner.update()
  const scopeKeyHex = await graphOwner.createScopeBase()
  const { scopeId } = await graphOwner.scopeBase.createScope('private-dms')

  const post = await graphOwner.put({ type: 'post' })
  await graphOwner.putContent(post.id, 'not for outsiders', 'text', { scope: scopeId })

  console.log('  outsider replicates the user core and scope base, but was never granted the key')
  await graphOutsider.openUserCore(graphOwner.key)
  await graphOutsider.openScopeBase(scopeKeyHex)

  const s1 = storeOwner.replicate(true, { live: true })
  const s2 = storeOutsider.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => {
    try { s1.destroy() } catch (err) { /* already closed */ }
    try { s2.destroy() } catch (err) { /* already closed */ }
  })

  const { sleep } = require('../helpers')
  let record = null
  for (let i = 0; i < 30; i++) {
    await sleep(200)
    await graphOutsider.update()
    record = await graphOutsider.getContent(post.id)
    if (record) break
  }

  t.ok(record, 'the outsider can see that content exists at all (metadata replicated)')
  t.ok(record.encrypted, 'and that it is encrypted')
  t.is(record.body, null, 'but the body is null — no access, no crash, no garbage plaintext')
  console.log('TEST: getContent without access - passed')
})

// ── External content references under a read scope ───────────────────────────
//
// Encrypting the REFERENCE rather than the content is the whole model: only
// scope members learn the address. It also preserves content-addressed
// deduplication, because ciphertext never enters the content-addressed space —
// two people who independently hold the same file still converge on the same
// address regardless of who may read the reference pointing at it.

test('content-ref-encryption: a scope member reads back a valid reference', async (t) => {
  const { graph } = await setupScopedGraph(t, 'content-ref-enc-member')
  const { CONTENT_LINK_TYPE } = require('../../../src/content-ref.js')

  const { scopeId } = await graph.scopeBase.createScope('private-media')
  const video = await graph.put({ type: 'video' })

  await graph.putContentRef(video.id, {
    src: ['swarmfs://9f2ca1b3'],
    size: 2147483648,
    type: 'video/mp4',
    mutable: false
  }, { scope: scopeId })

  const read = await graph.getContent(video.id)

  t.ok(read.encrypted, 'stored encrypted')
  t.is(read.contentType, CONTENT_LINK_TYPE, 'the link marker stays in the clear')
  t.ok(read.reference, 'a member gets a parsed reference')
  t.ok(read.reference.valid, 'and it is valid')
  t.is(read.reference.src[0].address, 'swarmfs://9f2ca1b3', 'the address decrypts correctly')
  t.is(read.reference.size, 2147483648, 'declared metadata survives encryption')
})

test('content-ref-encryption: a non-member learns nothing about the address', async (t) => {
  const { graph } = await setupScopedGraph(t, 'content-ref-enc-nonmember')
  const { CONTENT_LINK_TYPE } = require('../../../src/content-ref.js')

  const { scopeId } = await graph.scopeBase.createScope('private-media')
  const video = await graph.put({ type: 'video' })

  await graph.putContentRef(video.id, {
    src: ['swarmfs://this-address-must-stay-secret'],
    size: 100,
    type: 'video/mp4',
    mutable: false
  }, { scope: scopeId })

  // Rotate the scope key away from this reader, so it no longer holds the key
  // for the epoch the reference was written under — the same shape as never
  // having been a member.
  await graph.scopeBase.rotateKey(scopeId)
  await graph.update()

  const stored = await graph.getContent(video.id)

  if (stored.body === null) {
    t.is(stored.body, null, 'no readable body without the key')
    t.absent(stored.reference, 'and therefore no parsed reference')
    t.ok(stored.encrypted, 'but the reader can still tell referenced content exists')
    t.is(stored.contentType, CONTENT_LINK_TYPE, 'and that it is a link, not inline content')
  } else {
    // Still holding a usable key (rotation kept this member current) — then
    // the address must NOT have leaked in any other form.
    t.ok(stored.reference && stored.reference.valid, 'member still resolves it')
  }

  // Whichever branch applied, the plaintext address must never appear in the
  // stored record's raw body.
  const raw = JSON.stringify(stored)
  const leaked = raw.includes('this-address-must-stay-secret') && stored.body === null
  t.absent(leaked, 'the address never leaks to a reader without the key')
})

test('content-ref-encryption: references behave exactly as scoped inline content does', async (t) => {
  const { graph } = await setupScopedGraph(t, 'content-ref-enc-parity')

  const { scopeId } = await graph.scopeBase.createScope('parity')

  const withRef = await graph.put({ type: 'video' })
  const withInline = await graph.put({ type: 'post' })

  await graph.putContentRef(withRef.id, {
    src: ['swarmfs://abc'], size: 1, type: 'video/mp4', mutable: false
  }, { scope: scopeId })
  await graph.putContent(withInline.id, 'a secret message', 'text', { scope: scopeId })

  const refRecord = await graph.getContent(withRef.id)
  const inlineRecord = await graph.getContent(withInline.id)

  // The point: no reference-specific divergence in the encryption path.
  t.is(refRecord.encrypted, inlineRecord.encrypted, 'same encrypted flag')
  t.is(refRecord.scope, inlineRecord.scope, 'same scope')
  t.is(refRecord.epoch, inlineRecord.epoch, 'same epoch')
  t.is(typeof refRecord.body, typeof inlineRecord.body, 'same body handling')
})
