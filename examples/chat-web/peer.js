const Corestore = require('corestore')
const path = require('path')
const fs = require('fs')
const http = require('http')
const crypto = require('crypto')
const { Hypergraph } = require('../../index.js')
const ForumNetwork = require('../forum/network/hyperswarm')
const ChatStorage = require('./storage')
const { buildChatState } = require('./state')

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

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main () {
  const argv = process.argv.slice(2)

  const name = argValue(argv, 'name') || 'peer'
  const role = argValue(argv, 'role') || 'peer'
  const topic = argValue(argv, 'topic') || 'hyper-chat-demo'

  const defaultBaseDir = path.join(__dirname, '.chat-web')
  const storageDir = argValue(argv, 'storage') || path.join(defaultBaseDir, name)
  const bootstrapPath = argValue(argv, 'bootstrap') || path.join(defaultBaseDir, 'bootstrap.json')

  fs.mkdirSync(storageDir, { recursive: true })

  const store = new Corestore(storageDir)
  const graph = new Hypergraph(store)
  await graph.ready()

  let bootstrap = readJson(bootstrapPath)

  if (!bootstrap) {
    if (role !== 'owner') {
      throw new Error(`Missing bootstrap at ${bootstrapPath}. Start the owner first.`)
    }

    const messagesKey = await graph.createContext()

    const storage = new ChatStorage(graph, {
      messagesContext: messagesKey
    })

    bootstrap = {
      version: 1,
      topic,
      ownerCore: graph.key.toString('hex'),
      contexts: {
        messages: messagesKey
      }
    }

    writeJson(bootstrapPath, bootstrap)
  }

  if (!bootstrap || bootstrap.version !== 1) throw new Error('Invalid bootstrap')

  const effectiveTopic = bootstrap.topic || topic

  await graph.openContext(bootstrap.contexts.messages)

  if (bootstrap.ownerCore && bootstrap.ownerCore !== graph.key.toString('hex')) {
    await graph.openUserCore(bootstrap.ownerCore)
  }

  const storage = new ChatStorage(graph, {
    messagesContext: bootstrap.contexts.messages
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
      messagesWriter: null
    }

    const messages = graph.openContext(bootstrap.contexts.messages)

    messages.then((m) => {
      msg.messagesWriter = m.localKey.toString('hex')
      network.sendControl(conn, msg)
    }).catch(() => {})
  })

  network.on('control-message', async (msg, conn) => {
    if (role !== 'owner') return
    if (!msg || msg.type !== 'writer-request') return

    try {
      const userCore = typeof msg.userCore === 'string' ? msg.userCore : null
      if (userCore) await graph.openUserCore(userCore)

      const messagesCtx = await graph.openContext(bootstrap.contexts.messages)

      const messagesWriter = typeof msg.messagesWriter === 'string' ? msg.messagesWriter : null

      if (messagesWriter) await messagesCtx.addWriter(Buffer.from(messagesWriter, 'hex'))

      network.sendControl(conn, {
        type: 'writer-granted',
        messages: Boolean(messagesWriter)
      })

      console.log(`[${name}] granted writers messages=${Boolean(messagesWriter)}`)

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

  const announceToChat = async () => {
    try {
      const author = graph.key.toString('hex')
      await graph.relate({
        from: `usercore:${author}`,
        to: 'chat',
        type: 'announce',
        author,
        context: bootstrap.contexts.messages
      })
    } catch {}
  }

  const discoverPeerCores = async () => {
    try {
      await graph.update()
      for await (const e of graph.edges('chat', { direction: 'in', type: 'announce' })) {
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
    const state = await buildChatState(storage, {
      messages: bootstrap.contexts.messages
    }, { room: null })

    const sig = JSON.stringify({
      rooms: (state.rooms || []).map(r => `${r.id}:${r.messageCount || 0}`),
      room: state.room ? state.room.id : null
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
      const room = u.searchParams.get('room')
      try {
        await discoverPeerCores()
        const state = await buildChatState(storage, {
          messages: bootstrap.contexts.messages
        }, { room })
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

    if (req.method === 'POST' && u.pathname === '/api/rooms') {
      const body = await readBody(req)
      if (!body || !body.name) return sendText(res, 400, 'name required')
      try {
        const room = await storage.createRoom(String(body.name))
        await pushState()
        sendJson(res, 200, { ok: true, room })
      } catch (err) {
        sendText(res, 500, err && err.message ? err.message : String(err))
      }
      return
    }

    if (req.method === 'POST' && u.pathname === '/api/messages') {
      const body = await readBody(req)
      if (!body || !body.roomId || !body.body) return sendText(res, 400, 'roomId and body required')
      try {
        const message = await storage.sendMessage(String(body.roomId), String(body.body))
        await pushState()
        sendJson(res, 200, { ok: true, message })
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
        const node = await graph.get(id)
        if (!node) return sendText(res, 404, 'not found')

        const me = graph.key.toString('hex')
        if (node.author !== me) return sendText(res, 403, 'can only edit your own messages')

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
        const node = await graph.get(id)
        if (!node) return sendText(res, 404, 'not found')

        const me = graph.key.toString('hex')
        if (node.author !== me) return sendText(res, 403, 'can only delete your own messages')

        await graph.del(id)
        await pushState()
        sendJson(res, 200, { ok: true })
      } catch (err) {
        sendText(res, 500, err && err.message ? err.message : String(err))
      }
      return
    }

    sendText(res, 404, 'not found')
  })

  const messagesCtx = await graph.openContext(bootstrap.contexts.messages)

  const onChange = () => schedulePush()
  if (graph.core) {
    graph.core.on('append', onChange)
    graph.core.on('download', onChange)
  }
  if (messagesCtx.core) {
    messagesCtx.core.on('append', onChange)
    messagesCtx.core.on('download', onChange)
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
      const defaultUsername = role === 'owner' ? 'owner' : name
      await graph.setIdentity({ username: defaultUsername })

      await announceToChat()
      setInterval(() => { discoverPeerCores().catch(() => {}) }, 1500)
      await discoverPeerCores()

      if (role === 'owner') {
        await graph.update()
        const rooms = await storage.listRooms()
        if (rooms.length === 0) {
          await storage.createRoom('#general')
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
