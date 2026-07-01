const Corestore = require('corestore')
const path = require('path')
const fs = require('fs')
const http = require('http')
const crypto = require('crypto')
const { Hypergraph, HypergraphNetworking } = require('../../index.js')
const ForumNetwork = require('../forum/network/hyperswarm')
const ForumStorage = require('../forum/storage')
const { buildForumState, ForumPolicy } = require('./state')
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

function loadOrCreateMnemonic (storageDir) {
  const p = path.join(storageDir, 'identity-mnemonic.json')
  const existing = readJson(p)
  if (existing && existing.mnemonic) {
    return existing.mnemonic
  }

  const IdentityManager = require('../../src/identity-manager.js')
  const mnemonic = IdentityManager.generateMnemonic()
  writeJson(p, { mnemonic })
  return mnemonic
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

async function readNodeAuthor (graph, id) {
  const node = await graph.get(id)
  if (!node) return null
  return node.author || null
}

function parseTopic (topic) {
  return crypto.createHash('sha256').update(String(topic)).digest()
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function setupIdentityRegistry (store, graph, { storageDir, peerName }) {
  const { IdentityRegistry } = await import('../../lib/hyper-identity/lib/auth/identity-registry.js')
  const Hyperbee = (await import('hyperbee')).default

  const directCore = store.get({ name: 'identity-direct' })
  await directCore.ready()
  const directBee = new Hyperbee(directCore, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  await directBee.ready()

  const registry = new IdentityRegistry(store, { prefix: 'forum-web:', db: directBee })
  await registry.ready()

  const userPath = path.join(storageDir, 'user.json')
  const existing = readJson(userPath)

  let userId = existing && existing.userId ? existing.userId : null
  if (!userId) {
    const user = await registry.createUser({ name: peerName })
    userId = user.userId
    writeJson(userPath, { userId })
  }

  const pubkeyHex = graph.key.toString('hex')
  const identityId = `hypergraph:${pubkeyHex}`

  const prev = await registry.getIdentityByPublicKey(pubkeyHex)
  if (!prev) {
    await registry.registerIdentity({
      identityId,
      method: 'noise-key',
      publicKey: pubkeyHex,
      credentials: { publicKey: pubkeyHex },
      createdAt: Date.now(),
      userId
    })
  }

  const linked = await registry.getUserByIdentity(identityId)
  if (!linked) {
    await registry.linkIdentityToUser(identityId, userId, { verified: true })
  }

  return { registry, userId, identityId }
}

async function main () {
  const argv = process.argv.slice(2)

  const name = argValue(argv, 'name') || 'peer'
  const role = argValue(argv, 'role') || 'peer'
  const topic = argValue(argv, 'topic') || 'hyper-bbs-forum-demo'

  const defaultBaseDir = path.join(__dirname, '.forum-web')
  const storageDir = argValue(argv, 'storage') || path.join(defaultBaseDir, name)
  const bootstrapPath = argValue(argv, 'bootstrap') || path.join(defaultBaseDir, 'bootstrap.json')

  fs.mkdirSync(storageDir, { recursive: true })

  const mnemonic = loadOrCreateMnemonic(storageDir)

  const store = new Corestore(storageDir)
  const graph = new Hypergraph(store, { mnemonic })
  await graph.ready()

  let bootstrap = readJson(bootstrapPath)

  const moderationKeyPair = loadOrCreateModerationKeyPair(storageDir)

  if (!bootstrap) {
    if (role !== 'owner') {
      throw new Error(`Missing bootstrap at ${bootstrapPath}. Start the owner first.`)
    }

    const commentsKey = await graph.createContext()
    const moderationKey = await graph.createContext()

    const storage = new ForumStorage(graph, {
      commentsContext: commentsKey,
      moderationContext: moderationKey,
      moderationKeyPair
    })

    bootstrap = {
      version: 1,
      topic,
      ownerCore: graph.key.toString('hex'),
      contexts: {
        comments: commentsKey,
        moderation: moderationKey
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

  await graph.openContext(bootstrap.contexts.comments)
  await graph.openContext(bootstrap.contexts.moderation)

  if (bootstrap.ownerCore && bootstrap.ownerCore !== graph.key.toString('hex')) {
    await graph.openUserCore(bootstrap.ownerCore)
  }

  const storage = new ForumStorage(graph, {
    commentsContext: bootstrap.contexts.comments,
    moderationContext: bootstrap.contexts.moderation,
    moderationKeyPair: moderationKeyPair || undefined
  })

  const policy = new ForumPolicy({
    trustedModeratorKeys: (bootstrap.moderation && bootstrap.moderation.trustedModeratorKeys) || [],
    maxFlags: (bootstrap.moderation && typeof bootstrap.moderation.maxFlags === 'number') ? bootstrap.moderation.maxFlags : 3
  })

  const network = new ForumNetwork(store, { role })

  network.dataSwarm.on('connection', (_conn, info) => {
    const pk = info && info.publicKey ? Buffer.from(info.publicKey).toString('hex').slice(0, 8) : 'unknown'
    console.log(`[${name}] data connection peer=${pk}`)
  })

  network.controlSwarm.on('connection', (_conn, info) => {
    const pk = info && info.publicKey ? Buffer.from(info.publicKey).toString('hex').slice(0, 8) : 'unknown'
    console.log(`[${name}] control connection peer=${pk}`)
  })

  network.on('control-connection', (conn) => {
    if (role === 'owner') return
    const msg = {
      type: 'writer-request',
      userCore: graph.key.toString('hex'),
      commentsWriter: null,
      moderationWriter: null
    }

    const comments = graph.openContext(bootstrap.contexts.comments)
    const moderation = graph.openContext(bootstrap.contexts.moderation)

    Promise.all([comments, moderation]).then(([c, m]) => {
      msg.commentsWriter = c.localKey.toString('hex')
      msg.moderationWriter = m.localKey.toString('hex')
      network.sendControl(conn, msg)
    }).catch(() => {})
  })

  network.on('control-message', async (msg, conn) => {
    if (role !== 'owner') return
    if (!msg || msg.type !== 'writer-request') return

    try {
      const userCore = typeof msg.userCore === 'string' ? msg.userCore : null
      if (userCore) await graph.openUserCore(userCore)

      const commentsCtx = await graph.openContext(bootstrap.contexts.comments)
      const moderationCtx = await graph.openContext(bootstrap.contexts.moderation)

      const commentsWriter = typeof msg.commentsWriter === 'string' ? msg.commentsWriter : null
      const moderationWriter = typeof msg.moderationWriter === 'string' ? msg.moderationWriter : null

      if (commentsWriter) await commentsCtx.addWriter(Buffer.from(commentsWriter, 'hex'))
      if (moderationWriter) await moderationCtx.addWriter(Buffer.from(moderationWriter, 'hex'))

      network.sendControl(conn, {
        type: 'writer-granted',
        comments: Boolean(commentsWriter),
        moderation: Boolean(moderationWriter)
      })

      console.log(`[${name}] granted writers comments=${Boolean(commentsWriter)} moderation=${Boolean(moderationWriter)}`)

      schedulePush()
    } catch (err) {
      network.sendControl(conn, {
        type: 'writer-error',
        message: err && err.message ? err.message : String(err)
      })

      console.log(`[${name}] writer error: ${err && err.message ? err.message : String(err)}`)
    }
  })

  const uiHtmlPath = path.join(__dirname, 'ui', 'index.html')
  const uiHtml = fs.readFileSync(uiHtmlPath)

  const clients = new Set()
  let pushTimer = null
  let lastSig = null
  const watchedRemoteUserCores = new Set()

  const schedulePush = () => {
    if (pushTimer) return
    pushTimer = setTimeout(() => {
      pushTimer = null
      pushState().catch(() => {})
    }, 100)
  }

  const watchRemoteUserCore = (core) => {
    try {
      if (!core || !core.core) return
      const keyHex = core.core.key.toString('hex')
      if (watchedRemoteUserCores.has(keyHex)) return
      watchedRemoteUserCores.add(keyHex)
      core.core.on('append', schedulePush)
      core.core.on('download', schedulePush)
    } catch {}
  }

  const announceToForum = async () => {
    try {
      const author = graph.key.toString('hex')
      await graph.relate({
        from: `usercore:${author}`,
        to: 'forum',
        type: 'announce',
        author,
        context: bootstrap.contexts.comments
      })
    } catch {}
  }

  const discoverPeerCores = async () => {
    try {
      await graph.update()
      for await (const e of graph.edges('forum', { direction: 'in', type: 'announce' })) {
        const from = e && e.from ? String(e.from) : ''
        if (!from.startsWith('usercore:')) continue
        const keyHex = from.slice('usercore:'.length)
        if (!keyHex) continue
        const uc = await graph.openUserCore(keyHex)
        watchRemoteUserCore(uc)
      }
      schedulePush()
    } catch {}
  }

  const pushState = async () => {
    const state = await buildForumState(storage, {
      comments: bootstrap.contexts.comments,
      moderation: bootstrap.contexts.moderation
    }, policy, { thread: null })

    const sig = JSON.stringify({
      posts: (state.posts || []).map(p => `${p.id}:${p.replyCount || 0}`),
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
    const u = new URL(req.url, 'http://localhost')

    if (req.method === 'GET' && u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(uiHtml)
      return
    }

    if (req.method === 'GET' && u.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      res.write('\n')

      clients.add(res)
      req.on('close', () => clients.delete(res))

      discoverPeerCores().then(() => pushState()).catch(() => {})
      return
    }

    if (req.method === 'GET' && u.pathname === '/api/state') {
      const thread = u.searchParams.get('thread')
      try {
        await discoverPeerCores()
        const state = await buildForumState(storage, {
          comments: bootstrap.contexts.comments,
          moderation: bootstrap.contexts.moderation
        }, policy, { thread })
        sendJson(res, 200, state)
      } catch (err) {
        sendText(res, 500, err && err.message ? err.message : String(err))
      }
      return
    }

    if (req.method === 'POST' && u.pathname === '/api/identity') {
      const body = await readBody(req)
      if (!body || !body.username) return sendText(res, 400, 'username required')
      try {
        await graph.setIdentity({ username: String(body.username) })
        await pushState()
        sendJson(res, 200, { ok: true })
      } catch (err) {
        sendText(res, 500, err && err.message ? err.message : String(err))
      }
      return
    }

    if (req.method === 'POST' && u.pathname === '/api/posts') {
      const body = await readBody(req)
      if (!body || !body.body) return sendText(res, 400, 'body required')
      try {
        const post = await storage.createPost(String(body.body))
        await pushState()
        sendJson(res, 200, { ok: true, post })
      } catch (err) {
        sendText(res, 500, err && err.message ? err.message : String(err))
      }
      return
    }

    if (req.method === 'POST' && u.pathname === '/api/replies') {
      const body = await readBody(req)
      if (!body || !body.postId || !body.body) return sendText(res, 400, 'postId and body required')
      try {
        const comment = await storage.reply(String(body.postId), String(body.body))
        await pushState()
        sendJson(res, 200, { ok: true, comment })
      } catch (err) {
        sendText(res, 500, err && err.message ? err.message : String(err))
      }
      return
    }

    if (req.method === 'POST' && u.pathname === '/api/edit') {
      const body = await readBody(req)
      if (!body || !body.id || !body.body) return sendText(res, 400, 'id and body required')
      try {
        const id = String(body.id)
        const author = await readNodeAuthor(graph, id)
        if (!author) return sendText(res, 404, 'not found')

        const me = graph.key.toString('hex')
        if (author !== me) return sendText(res, 403, 'can only edit your own posts/replies')

        const content = await graph.putContent(id, String(body.body), 'text')
        await pushState()
        sendJson(res, 200, { ok: true, content })
      } catch (err) {
        sendText(res, 500, err && err.message ? err.message : String(err))
      }
      return
    }

    if (req.method === 'POST' && u.pathname === '/api/delete') {
      const body = await readBody(req)
      if (!body || !body.id) return sendText(res, 400, 'id required')
      try {
        const id = String(body.id)
        const author = await readNodeAuthor(graph, id)
        if (!author) return sendText(res, 404, 'not found')

        const me = graph.key.toString('hex')
        const isModerator = policy.trustedModeratorKeys.has(moderationKeyPair.publicKey.toString('hex'))

        if (author === me) {
          await graph.del(id)
        } else {
          if (!isModerator) return sendText(res, 403, 'only moderators can delete others')
          await storage.moderate(id, 'content.remove', null)
        }

        await pushState()
        sendJson(res, 200, { ok: true })
      } catch (err) {
        sendText(res, 500, err && err.message ? err.message : String(err))
      }
      return
    }

    if (req.method === 'POST' && u.pathname === '/api/moderation') {
      const body = await readBody(req)
      if (!body || !body.targetId || !body.action) return sendText(res, 400, 'targetId and action required')
      try {
        const ev = await storage.moderate(String(body.targetId), String(body.action), body.reason ? String(body.reason) : null)
        await pushState()
        sendJson(res, 200, { ok: true, event: ev })
      } catch (err) {
        sendText(res, 500, err && err.message ? err.message : String(err))
      }
      return
    }

    sendText(res, 404, 'not found')
  })

  const commentsCtx = await graph.openContext(bootstrap.contexts.comments)
  const moderationCtx = await graph.openContext(bootstrap.contexts.moderation)

  const onChange = () => schedulePush()
  if (graph.core) {
    graph.core.on('append', onChange)
    graph.core.on('download', onChange)
  }
  if (commentsCtx.core) {
    commentsCtx.core.on('append', onChange)
    commentsCtx.core.on('download', onChange)
  }
  if (moderationCtx.core) {
    moderationCtx.core.on('append', onChange)
    moderationCtx.core.on('download', onChange)
  }

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    const port = addr && addr.port ? addr.port : 0
    console.log(`[${name}] role=${role} topic=${effectiveTopic}`)
    console.log(`[${name}] bootstrap=${bootstrapPath}`)
    console.log(`[${name}] url=http://127.0.0.1:${port}`)
  })

  ;(async () => {
    for (;;) {
      try {
        const joinPromise = network.join(parseTopic(effectiveTopic))
        await Promise.race([
          joinPromise,
          sleep(10000).then(() => { throw new Error('join timeout') })
        ])
        break
      } catch (err) {
        console.error(`[${name}] join error: ${err && err.message ? err.message : String(err)}`)
        await sleep(1000)
      }
    }

    try {
      await setupIdentityRegistry(store, graph, { storageDir, peerName: name })
      const defaultUsername = role === 'owner' ? 'owner' : name
      await graph.setIdentity({ username: defaultUsername })

      await announceToForum()
      setInterval(() => { discoverPeerCores().catch(() => {}) }, 1500)
      await discoverPeerCores()

      if (role === 'owner') {
        await graph.update()
        const posts = await storage.listPosts()
        if (posts.length === 0) {
          await storage.createPost('Hello from the owner')
        }
      }

      schedulePush()
    } catch (err) {
      console.error(`[${name}] init error: ${err && err.message ? err.message : String(err)}`)
    }
  })()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
