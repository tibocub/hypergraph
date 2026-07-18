const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const path = require('path')
const fs = require('fs')
const http = require('http')
const crypto = require('crypto')
const { Hypergraph, HypergraphNetwork } = require('../../index.js')
const RedditStorage = require('./storage')
const { buildRedditState, RedditPolicy } = require('./state')
const hypercoreCrypto = require('hypercore-crypto')

function argValue (argv, key) {
  const pref = `--${key}=`
  const a = argv.find(v => v.startsWith(pref))
  return a ? a.slice(pref.length) : null
}

function readJson (p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}

function writeJson (p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(value, null, 2))
}

function loadOrCreateModerationKeyPair (storageDir) {
  const p = path.join(storageDir, 'moderation-keypair.json')
  const existing = readJson(p)
  if (existing && existing.publicKey && existing.secretKey) {
    return {
      publicKey: Buffer.from(existing.publicKey, 'hex'),
      secretKey: Buffer.from(existing.secretKey, 'hex')
    }
  }

  const kp = hypercoreCrypto.keyPair()
  writeJson(p, {
    publicKey: kp.publicKey.toString('hex'),
    secretKey: kp.secretKey.toString('hex')
  })
  return kp
}

async function readBody (req) {
  let buf = ''
  for await (const chunk of req) buf += chunk.toString('utf-8')
  if (!buf) return null
  try {
    return JSON.parse(buf)
  } catch {
    return null
  }
}

function sendJson (res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

function parseTopic (topic) {
  return crypto.createHash('sha256').update(String(topic)).digest()
}

async function main () {
  console.log('Starting P2P Reddit Clone peer...')
  const role = argValue(process.argv, 'role') || 'peer'
  const port = Number(argValue(process.argv, 'port')) || (role === 'owner' ? 8080 : 8081)
  const name = argValue(process.argv, 'name') || role
  const topic = argValue(process.argv, 'topic') || 'p2p-reddit-v1'

  const defaultBaseDir = path.join(__dirname, '.reddit-storage')
  const storageDir = argValue(process.argv, 'storage') || path.join(defaultBaseDir, name)
  const bootstrapPath = argValue(process.argv, 'bootstrap') || path.join(defaultBaseDir, 'bootstrap.json')

  console.log(`Role: ${role}, Port: ${port}, Storage: ${storageDir}`)

  fs.mkdirSync(storageDir, { recursive: true })

  const store = new Corestore(storageDir)
  console.log('Corestore created')
  const graph = new Hypergraph(store)
  console.log('Hypergraph created')
  await graph.ready()
  console.log('Hypergraph ready')

  let bootstrap = readJson(bootstrapPath)
  console.log('Bootstrap loaded:', bootstrap ? 'found' : 'not found')

  const moderationKeyPair = loadOrCreateModerationKeyPair(storageDir)
  console.log('Moderation keypair loaded')

  if (!bootstrap) {
    console.log('Creating new bootstrap (owner mode)')
    if (role !== 'owner') {
      throw new Error(`Missing bootstrap at ${bootstrapPath}. Start the owner first.`)
    }

    console.log('Creating context...')
    let contextKey
    try {
      contextKey = await graph.createContext()
      console.log('Context created')
    } catch (err) {
      console.error('Error creating context:', err)
      throw err
    }

    // A single context is used for comments, votes, and moderation alike
    // (matches how RedditStorage is constructed below — all three point at
    // the same key). generateBootstrap()'s metadata field carries the
    // app-specific moderation config alongside the standard bootstrap
    // shape (topic/ownerCore/contexts), so a joining peer gets everything
    // it needs from one JSON file via connectFromBootstrap().
    bootstrap = HypergraphNetwork.generateBootstrap(graph, {
      topic: parseTopic(topic),
      contexts: {
        comments: contextKey,
        votes: contextKey,
        moderation: contextKey
      },
      metadata: {
        moderation: {
          trustedModeratorKeys: [moderationKeyPair.publicKey.toString('hex')],
          maxFlags: 3
        }
      }
    })

    writeJson(bootstrapPath, bootstrap)
  }

  const effectiveTopic = bootstrap.topic

  if (role === 'owner' && moderationKeyPair) {
    const pub = moderationKeyPair.publicKey.toString('hex')
    const modMeta = (bootstrap.metadata && bootstrap.metadata.moderation) || {}
    const keys = modMeta.trustedModeratorKeys || []
    const hasMaxFlags = typeof modMeta.maxFlags === 'number'

    // Always ensure owner's moderation key is in the trusted list — handles
    // the case where the bootstrap was generated with a different identity
    // (e.g. storage was reset) than the one currently running as owner.
    if (!keys.includes(pub) || !hasMaxFlags) {
      bootstrap.metadata = bootstrap.metadata || {}
      bootstrap.metadata.moderation = modMeta
      bootstrap.metadata.moderation.trustedModeratorKeys = keys.includes(pub) ? keys : keys.concat([pub])
      if (!hasMaxFlags) bootstrap.metadata.moderation.maxFlags = 3
      writeJson(bootstrapPath, bootstrap)
      console.log(`[${name}] updated bootstrap with owner's moderation key: ${pub.slice(0, 8)}`)
    }
  }

  const swarm = new Hyperswarm()

  // HypergraphNetwork replaces the manual writer-request/grant protocol
  // this app previously had to hand-roll (see forum-web/chat-web's
  // control-connection/control-message wiring for comparison) — the
  // handshake, permission checking, and signing all happen automatically
  // once connect() is called. The owner constructs it directly (it already
  // has the graph/context); a peer consumes the bootstrap descriptor
  // instead, which also opens the owner's user core automatically.
  const networking = role === 'owner'
    ? new HypergraphNetwork(graph, store, swarm, {
        topic: effectiveTopic,
        contexts: bootstrap.contexts,
        role: 'owner'
      })
    : await HypergraphNetwork.connectFromBootstrap(graph, store, swarm, bootstrap, { role: 'peer' })

  networking.on('peer-join', () => {
    console.log(`[${name}] peer joined`)
  })

  networking.on('writer-granted', (msg) => {
    console.log(`[${name}] writer granted for:`, Object.keys(msg.contexts || {}).filter(k => msg.contexts[k]))
  })

  networking.on('writer-error', (msg) => {
    console.log(`[${name}] writer error: ${msg && msg.message}`)
  })

  // Deliberately NOT awaited here: connect() waits for an actual peer
  // connection (with retries), which can legitimately take a couple of
  // minutes — or never resolve at all if no peer ever joins, which is a
  // completely normal case (e.g. the first person setting up a community
  // before anyone else has joined yet). None of the app's local
  // functionality below actually depends on a peer being connected, so it
  // shouldn't be blocked on this. Confirmed directly: without this fix,
  // the HTTP server (and the entire UI) was unreachable for however long
  // connect() took to resolve or give up.
  networking.connect()
    .then(() => console.log(`[${name}] connected to swarm`))
    .catch((err) => console.error(`[${name}] connect error: ${err && err.message ? err.message : String(err)}`))

  const storage = new RedditStorage(graph, {
    commentsContext: bootstrap.contexts.comments,
    votesContext: bootstrap.contexts.votes,
    moderationContext: bootstrap.contexts.moderation,
    moderationKeyPair: moderationKeyPair || undefined
  })

  const modMeta = (bootstrap.metadata && bootstrap.metadata.moderation) || {}
  const policy = new RedditPolicy({
    trustedModeratorKeys: modMeta.trustedModeratorKeys || [],
    maxFlags: typeof modMeta.maxFlags === 'number' ? modMeta.maxFlags : 3
  })

  const uiHtmlPath = path.join(__dirname, 'ui', 'index.html')
  const uiHtml = fs.readFileSync(uiHtmlPath)

  const clients = new Set()
  let lastSig = null

  const schedulePush = () => {
    setTimeout(pushState, 100)
  }

  const pushState = async () => {
    const state = await buildRedditState(storage, {
      comments: bootstrap.contexts.comments,
      votes: bootstrap.contexts.votes,
      moderation: bootstrap.contexts.moderation
    }, policy, { thread: null })

    const sig = JSON.stringify({
      posts: (state.posts || []).map(p => `${p.id}:${p.voteCount}:${p.commentCount}`),
      thread: state.thread ? state.thread.id : null
    })

    if (sig === lastSig) return
    lastSig = sig

    const payload = `data: ${JSON.stringify({ type: 'state:update', state })}\n\n`
    for (const res of clients) {
      try {
        res.write(payload)
      } catch {}
    }
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(uiHtml)
      return
    }

    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      clients.add(res)
      res.on('close', () => clients.delete(res))
      pushState()
      return
    }

    if (req.method === 'GET' && req.url === '/api/state') {
      const state = await buildRedditState(storage, {
        comments: bootstrap.contexts.comments,
        votes: bootstrap.contexts.votes,
        moderation: bootstrap.contexts.moderation
      }, policy)
      sendJson(res, 200, state)
      return
    }

    if (req.method === 'POST' && req.url === '/api/posts') {
      const body = await readBody(req)
      if (!body || !body.body) {
        sendJson(res, 400, { error: 'Missing body' })
        return
      }

      const post = await storage.createPost(body.body)
      if (body.username) {
        await storage.setIdentity({ username: body.username })
      }
      schedulePush()
      sendJson(res, 200, { id: post.id })
      return
    }

    if (req.method === 'POST' && req.url.startsWith('/api/posts/') && req.url.includes('/comments')) {
      const urlParts = req.url.split('/comments')[0]
      const postId = urlParts.slice('/api/posts/'.length)
      const body = await readBody(req)
      if (!body || !body.body) {
        sendJson(res, 400, { error: 'Missing body' })
        return
      }

      try {
        const comment = await storage.createComment(postId, body.body)
        schedulePush()
        sendJson(res, 200, { id: comment.id })
      } catch (err) {
        console.error('Comment error:', err)
        sendJson(res, 500, { error: err.message })
      }
      return
    }

    if (req.method === 'POST' && req.url.startsWith('/api/vote/')) {
      const targetId = req.url.slice('/api/vote/'.length)
      const body = await readBody(req)
      if (!body || typeof body.value !== 'number') {
        sendJson(res, 400, { error: 'Missing value' })
        return
      }

      try {
        await storage.vote(targetId, body.value)
        schedulePush()
        sendJson(res, 200, { success: true })
      } catch (err) {
        console.error('Vote error:', err)
        sendJson(res, 500, { error: err.message })
      }
      return
    }

    if (req.method === 'POST' && req.url.startsWith('/api/moderate/')) {
      const targetId = req.url.split('/')[3]
      const body = await readBody(req)
      if (!body || !body.action) {
        sendJson(res, 400, { error: 'Missing action' })
        return
      }

      await storage.moderate(targetId, body.action, body.reason)
      schedulePush()
      sendJson(res, 200, { success: true })
      return
    }

    if (req.method === 'POST' && req.url === '/api/identity') {
      const body = await readBody(req)
      if (!body) {
        sendJson(res, 400, { error: 'Missing body' })
        return
      }

      await storage.setIdentity(body)
      schedulePush()
      sendJson(res, 200, { success: true })
      return
    }

    sendJson(res, 404, { error: 'Not found' })
  })

  server.listen(port, () => {
    console.log(`[${name}] listening on http://localhost:${port}`)
  })

  // Announce this peer's user core to the graph, and discover other peers'
  // user cores the same way. This is unrelated to HypergraphNetwork's own
  // 'peer-join' event, whose peerKey is the Hyperswarm/Noise connection
  // identity — a different keypair entirely from a peer's Hypergraph
  // user-core key, so it can't be used to open their data directly. This
  // announce/discover-via-edges pattern is the correct way to find the
  // actual user-core keys to open.
  const announceToReddit = async () => {
    try {
      const author = graph.key.toString('hex')
      await graph.relate({
        from: `usercore:${author}`,
        to: 'reddit',
        type: 'announce',
        author,
        context: bootstrap.contexts.comments
      })
    } catch {}
  }

  const discoverPeerCores = async () => {
    try {
      await graph.update()
      for await (const e of graph.edges('reddit', { direction: 'in', type: 'announce' })) {
        const from = e && e.from ? String(e.from) : ''
        if (!from.startsWith('usercore:')) continue

        const keyHex = from.slice('usercore:'.length)
        if (!keyHex) continue
        const localKey = graph.key ? graph.key.toString('hex') : null
        if (localKey && keyHex === localKey) continue

        await graph.openUserCore(keyHex)
      }
    } catch {}
  }

  setInterval(() => announceToReddit().catch(() => {}), 5000)
  setInterval(() => discoverPeerCores().catch(() => {}), 5000)
  setInterval(() => pushState().catch(() => {}), 1000)

  await announceToReddit()
  await discoverPeerCores()
  pushState()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
