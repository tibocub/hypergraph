const Corestore = require('corestore')
const path = require('path')
const fs = require('fs')
const http = require('http')
const crypto = require('crypto')
const { Hypergraph, HypergraphNetworking } = require('../../index.js')
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

function sendText (res, status, value) {
  const body = String(value)
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
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

    const storage = new RedditStorage(graph, {
      commentsContext: contextKey,
      votesContext: contextKey,
      moderationContext: contextKey,
      moderationKeyPair
    })

    bootstrap = {
      version: 1,
      topic,
      ownerCore: graph.key.toString('hex'),
      contexts: {
        comments: contextKey,
        votes: contextKey,
        moderation: contextKey
      },
      moderation: {
        trustedModeratorKeys: [storage.moderationKeyPair.publicKey.toString('hex')],
        maxFlags: 3
      }
    }

    writeJson(bootstrapPath, bootstrap)
  }

  if (!bootstrap || bootstrap.version !== 1) throw new Error('Invalid bootstrap')

  const effectiveTopic = bootstrap.topic || topic

  if (role === 'owner' && moderationKeyPair) {
    const pub = moderationKeyPair.publicKey.toString('hex')
    const keys = (bootstrap.moderation && bootstrap.moderation.trustedModeratorKeys)
      ? bootstrap.moderation.trustedModeratorKeys
      : []

    const hasMaxFlags = Boolean(bootstrap.moderation && typeof bootstrap.moderation.maxFlags === 'number')

    if (!keys.includes(pub) || !hasMaxFlags) {
      bootstrap.moderation = bootstrap.moderation || {}
      if (!keys.includes(pub)) bootstrap.moderation.trustedModeratorKeys = keys.concat([pub])
      if (!hasMaxFlags) bootstrap.moderation.maxFlags = 3
      writeJson(bootstrapPath, bootstrap)
    }
  }

  // Contexts are automatically available - no need to explicitly open them

  if (bootstrap.ownerCore && bootstrap.ownerCore !== graph.key.toString('hex')) {
    await graph.openUserCore(bootstrap.ownerCore)
  }

  const storage = new RedditStorage(graph, {
    commentsContext: bootstrap.contexts.comments,
    votesContext: bootstrap.contexts.votes,
    moderationContext: bootstrap.contexts.moderation,
    moderationKeyPair: moderationKeyPair || undefined
  })

  const policy = new RedditPolicy({
    trustedModeratorKeys: (bootstrap.moderation && bootstrap.moderation.trustedModeratorKeys) || [],
    maxFlags: (bootstrap.moderation && typeof bootstrap.moderation.maxFlags === 'number') ? bootstrap.moderation.maxFlags : 3
  })

  // Use HypergraphNetworking instead of custom ForumNetwork
  const networking = new HypergraphNetworking(graph, store, {
    topic: parseTopic(effectiveTopic),
    contexts: {
      comments: bootstrap.contexts.comments,
      votes: bootstrap.contexts.votes,
      moderation: bootstrap.contexts.moderation
    },
    autoAddWriters: true
  })

  networking.on('peer-join', async ({ peerKey }) => {
    const pk = peerKey ? peerKey.toString('hex').slice(0, 8) : 'unknown'
    console.log(`[${name}] peer joined: ${pk}`)

    // Open peer's user core to see their posts/comments
    const keyHex = peerKey ? peerKey.toString('hex') : null
    if (keyHex) {
      try {
        await graph.openUserCore(keyHex)
        console.log(`[${name}] opened user core for peer: ${pk}`)
      } catch (err) {
        console.error(`[${name}] failed to open user core for peer ${pk}:`, err)
      }
    }
  })

  await networking.connect()
  console.log(`[${name}] connected to swarm`)

  const uiHtmlPath = path.join(__dirname, 'ui', 'index.html')
  console.log('Reading UI HTML from:', uiHtmlPath)
  const uiHtml = fs.readFileSync(uiHtmlPath)
  console.log('UI HTML read successfully, length:', uiHtml.length)

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
    console.log('Request:', req.method, req.url)
    if (req.method === 'GET' && req.url === '/') {
      console.log('Serving UI HTML, length:', uiHtml.length)
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(uiHtml)
      return
    }

    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive'
      })
      clients.add(res)
      res.on('close', () => clients.delete(res))
      pushState()
      return
    }

    if (req.method === 'GET' && req.url === '/api/state') {
      console.log('GET /api/state - building state...')
      const state = await buildRedditState(storage, {
        comments: bootstrap.contexts.comments,
        votes: bootstrap.contexts.votes,
        moderation: bootstrap.contexts.moderation
      }, policy)
      console.log('GET /api/state - state built, sending response')
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
      console.log('Vote endpoint hit, URL:', req.url)
      const targetId = req.url.slice('/api/vote/'.length)
      console.log('Extracted targetId:', targetId)
      const body = await readBody(req)
      console.log('Vote body:', body)
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

  // Announce usercore periodically
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

  // Discover peer usercores periodically
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

  // Periodic tasks
  setInterval(() => announceToReddit().catch(() => {}), 5000)
  setInterval(() => discoverPeerCores().catch(() => {}), 5000)
  setInterval(() => pushState().catch(() => {}), 1000)

  // Initial tasks
  await announceToReddit()
  await discoverPeerCores()
  pushState()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
