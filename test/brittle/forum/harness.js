const Corestore = require('corestore')
const { Hypergraph } = require('../../../index.js')
const ForumStorage = require('../../../examples/forum/storage')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { isDeepStrictEqual } = require('node:util')

async function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function tmpDir (name) {
  const dir = path.join(os.tmpdir(), `hypergraph-forum-${name}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function createPeer (name, opts = {}) {
  const dir = opts.dir || tmpDir(name)
  const store = new Corestore(dir)
  const graph = new Hypergraph(store, {
    userCoreKey: opts.userCoreKey || null
  })
  await graph.ready()

  const storage = new ForumStorage(graph, {
    commentsContext: opts.commentsContext || null,
    moderationContext: opts.moderationContext || null
  })

  return { name, dir, store, graph, storage }
}

function replicatePair (peerA, peerB) {
  // Corestore.replicate returns a protocol stream; wire the two ends together.
  const s1 = peerA.store.replicate(true, { live: true })
  const s2 = peerB.store.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)

  const close = async () => {
    try { s1.destroy() } catch {}
    try { s2.destroy() } catch {}
  }

  return { close }
}

async function pumpUntil (fn, timeoutMs = 20000, intervalMs = 50) {
  const start = Date.now()
  let lastErr = null

  for (;;) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
    }

    if (Date.now() - start > timeoutMs) {
      const e = new Error('Timeout waiting for condition')
      e.cause = lastErr
      throw e
    }

    await sleep(intervalMs)
  }
}

function printSnapshotDiff (a, b) {
  console.dir({ a, b }, { depth: null })
}

async function snapshotRaw (peer, { postIds = null, targetIds = null } = {}) {
  await peer.graph.update()

  const posts = await peer.storage.listPosts()
  const postList = posts.map(p => ({ id: p.id, author: p.author }))

  const ids = postIds || postList.map(p => p.id)
  const targets = targetIds || ids

  const replyEdgesByPost = {}
  for (const id of ids) {
    const edges = []
    for await (const e of peer.graph.edges(id, { direction: 'in', type: 'reply' })) {
      edges.push({ from: e.from, to: e.to, type: e.type, deleted: Boolean(e.deleted) })
    }
    edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
    replyEdgesByPost[id] = edges
  }

  const moderationByTarget = {}
  if (peer.storage.moderationContext) {
    for (const id of targets) {
      const events = await peer.storage.getModeration(id)
      const minimal = events.map(ev => ({
        author: ev.author,
        action: ev.action,
        target: ev.target,
        createdAt: ev.createdAt,
        signature: ev.signature,
        eventId: ev.eventId
      }))
      minimal.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0))
      moderationByTarget[id] = minimal
    }
  }

  return {
    posts: postList.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    replyEdgesByPost,
    moderationByTarget
  }
}

async function snapshotCanonical (peer, { postIds = null, targetIds = null } = {}) {
  const raw = await snapshotRaw(peer, { postIds, targetIds })

  const posts = raw.posts.map(p => p.id).sort()
  const replyScope = postIds ? Array.from(new Set(postIds)).sort() : posts

  const replies = {}
  for (const postId of replyScope) {
    const edges = raw.replyEdgesByPost[postId] || []
    const ids = []
    for (const e of edges) {
      if (e.deleted) continue
      ids.push(e.from)
    }
    replies[postId] = Array.from(new Set(ids)).sort()
  }

  const moderation = {}
  if (peer.storage.moderationContext) {
    const moderationTargets = targetIds || posts
    for (const targetId of moderationTargets) {
      const events = raw.moderationByTarget[targetId] || []
      const seen = new Set()
      const entries = []

      for (const ev of events) {
        const key = `${ev.author}:${ev.action}:${targetId}`
        if (seen.has(key)) continue
        seen.add(key)
        entries.push({ author: ev.author, action: ev.action })
      }

      entries.sort((a, b) => {
        if (a.author < b.author) return -1
        if (a.author > b.author) return 1
        if (a.action < b.action) return -1
        if (a.action > b.action) return 1
        return 0
      })

      moderation[targetId] = entries
    }
  }

  // Minimal referenced entities map, inserted in sorted id order.
  const referenced = new Set()
  for (const postId of posts) referenced.add(postId)
  for (const postId of Object.keys(replies)) {
    for (const commentId of replies[postId] || []) referenced.add(commentId)
  }
  for (const targetId of Object.keys(moderation)) referenced.add(targetId)

  const entityIds = Array.from(referenced).sort()
  const entities = {}
  for (const id of entityIds) {
    const node = await peer.graph.get(id)
    if (!node) continue
    entities[id] = { type: node.type, author: node.author }
  }

  return { posts, entities, replies, moderation }
}

async function getWriters (peer, { contexts = [] } = {}) {
  const out = {
    contexts: {},
    userCores: peer.graph.userCoreKeys()
  }

  for (const ctx of contexts) {
    if (!ctx) continue
    const keyHex = ctx.key ? ctx.key.toString('hex') : null
    if (!keyHex) continue
    const keys = typeof ctx.writerKeys === 'function' ? ctx.writerKeys() : []
    out.contexts[keyHex] = keys
  }

  // Insert contexts deterministically.
  out.contexts = Object.fromEntries(Object.keys(out.contexts).sort().map(k => [k, out.contexts[k]]))
  out.userCores = Array.from(new Set(out.userCores)).sort()

  return out
}

async function snapshotDebug (peer, opts = {}) {
  const raw = await snapshotRaw(peer, opts)
  const canonical = await snapshotCanonical(peer, opts)

  const contexts = [peer.storage.commentsContext, peer.storage.moderationContext].filter(Boolean)
  const writers = await getWriters(peer, { contexts })

  return {
    name: peer.name,
    canonical,
    raw,
    writers
  }
}

async function settle (peers, opts = {}) {
  const idleMs = opts.idleMs ?? 100
  const minDurationMs = opts.minDurationMs ?? 0
  const timeoutMs = opts.timeoutMs ?? 15000
  const pollMs = opts.pollMs ?? 25
  const snapshotOpts = opts.snapshotOpts ?? {}

  const start = Date.now()
  let lastChange = Date.now()
  let lastSnaps = new Map()

  for (;;) {
    const snaps = []
    for (const p of peers) {
      const snap = await snapshotCanonical(p, snapshotOpts)
      snaps.push(snap)

      const prev = lastSnaps.get(p)
      if (!prev || !isDeepStrictEqual(prev, snap)) {
        lastSnaps.set(p, snap)
        lastChange = Date.now()
      }
    }

    // Convergence: all peers identical.
    let equal = true
    for (let i = 1; i < snaps.length; i++) {
      if (!isDeepStrictEqual(snaps[0], snaps[i])) {
        equal = false
        break
      }
    }

    const elapsed = Date.now() - start
    const idleFor = Date.now() - lastChange

    if (elapsed >= minDurationMs && idleFor >= idleMs && equal) return

    if (elapsed > timeoutMs) {
      const debug = await Promise.all(peers.map(p => snapshotDebug(p, snapshotOpts)))
      if (debug.length >= 2) printSnapshotDiff(debug[0], debug[1])
      throw new Error('settle timeout')
    }

    await sleep(pollMs)
  }
}

async function assertConverged (t, peers, opts = {}) {
  await settle(peers, opts)
  const snaps = await Promise.all(peers.map(p => snapshotCanonical(p, opts.snapshotOpts ?? {})))
  for (let i = 1; i < snaps.length; i++) t.alike(snaps[0], snaps[i])
}

async function cleanupPeer (peer) {
  try { await peer.graph.close() } catch {}
  try { await peer.store.close() } catch {}
  try { fs.rmSync(peer.dir, { recursive: true, force: true }) } catch {}
}

module.exports = {
  createPeer,
  replicatePair,
  pumpUntil,
  snapshotRaw,
  snapshotDebug,
  snapshotCanonical,
  snapshot: snapshotCanonical,
  settle,
  getWriters,
  assertConverged,
  printSnapshotDiff,
  cleanupPeer
}
