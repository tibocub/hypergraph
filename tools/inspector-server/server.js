const http = require('http')
const path = require('path')
const fs = require('fs')
const InspectorSession = require('./session')
const runQueryV0 = require('./hgq-v0')

function readBody (req) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.setEncoding('utf8')
    req.on('data', (d) => { buf += d })
    req.on('end', () => {
      try {
        resolve(buf.length ? JSON.parse(buf) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson (res, code, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function sendText (res, code, text, contentType = 'text/plain; charset=utf-8') {
  res.statusCode = code
  res.setHeader('content-type', contentType)
  res.end(text)
}

function safeResolveUiPath (uiDir, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath
  const filePath = path.resolve(uiDir, '.' + rel)
  if (!filePath.startsWith(path.resolve(uiDir))) return null
  return filePath
}

async function handleApi (session, req, res) {
  const graph = session.graph

  if (req.method === 'GET' && req.url === '/api/meta') {
    if (!graph) return sendJson(res, 400, { error: 'No session open' })
    const roleBaseKey = graph.roleBase && graph.roleBase.key ? graph.roleBase.key.toString('hex') : null
    return sendJson(res, 200, {
      corestoreDir: session.corestoreDir,
      key: graph.key ? graph.key.toString('hex') : null,
      discoveryKey: graph.discoveryKey ? graph.discoveryKey.toString('hex') : null,
      roleBase: roleBaseKey,
      openedContexts: session.openedContexts
    })
  }

  if (req.method === 'POST' && req.url === '/api/newdb') {
    const body = await readBody(req)
    const out = await session.newDb({ prefix: body.prefix })
    return sendJson(res, 200, out)
  }

  if (req.method === 'POST' && req.url === '/api/open') {
    const body = await readBody(req)
    const out = await session.open(body.corestoreDir)
    return sendJson(res, 200, out)
  }

  if (req.method === 'POST' && req.url === '/api/bootstrap/openFromDisk') {
    if (!graph) return sendJson(res, 400, { error: 'No session open' })
    const body = await readBody(req)
    const filename = body.filename || 'bootstrap.json'

    const corestoreDir = session.corestoreDir
    if (!corestoreDir) return sendJson(res, 400, { error: 'No corestoreDir in session' })

    // forum-web layout: <base>/.forum-web/bootstrap.json and storage=<base>/.forum-web/<name>
    // user often points inspector to the storage dir itself, so we try a couple of likely locations.
    const candidates = [
      path.resolve(corestoreDir, '..', filename),
      path.resolve(corestoreDir, '..', '..', filename),
      path.resolve(corestoreDir, filename)
    ]

    let bootstrapPath = null
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        bootstrapPath = p
        break
      }
    }

    if (!bootstrapPath) return sendJson(res, 404, { error: 'bootstrap file not found near corestoreDir' })

    const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, 'utf-8'))
    if (!bootstrap || bootstrap.version !== 1 || !bootstrap.contexts) {
      return sendJson(res, 400, { error: 'Invalid bootstrap file' })
    }

    if (bootstrap.contexts.comments) {
      await graph.openContext(bootstrap.contexts.comments)
      session.noteContextOpened(bootstrap.contexts.comments)
    }

    if (bootstrap.contexts.moderation) {
      await graph.openContext(bootstrap.contexts.moderation)
      session.noteContextOpened(bootstrap.contexts.moderation)
    }

    if (bootstrap.ownerCore && bootstrap.ownerCore !== graph.key.toString('hex')) {
      await graph.openUserCore(bootstrap.ownerCore)
    }

    return sendJson(res, 200, {
      bootstrapPath,
      openedContexts: session.openedContexts
    })
  }

  if (req.method === 'POST' && req.url === '/api/site/openFromDisk') {
    if (!graph) return sendJson(res, 400, { error: 'No session open' })
    const body = await readBody(req)
    const filename = body.filename || 'site.json'

    const corestoreDir = session.corestoreDir
    if (!corestoreDir) return sendJson(res, 400, { error: 'No corestoreDir in session' })

    const candidates = [
      path.resolve(corestoreDir, '..', filename),
      path.resolve(corestoreDir, '..', '..', filename),
      path.resolve(corestoreDir, filename)
    ]

    let manifestPath = null
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        manifestPath = p
        break
      }
    }

    if (!manifestPath) return sendJson(res, 404, { error: 'site.json not found near corestoreDir' })

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    if (!manifest || manifest.version !== 1 || !manifest.contexts || !manifest.owner) {
      return sendJson(res, 400, { error: 'Invalid site.json' })
    }

    if (manifest.contexts.comments) {
      await graph.openContext(manifest.contexts.comments)
      session.noteContextOpened(manifest.contexts.comments)
    }

    if (manifest.contexts.moderation) {
      await graph.openContext(manifest.contexts.moderation)
      session.noteContextOpened(manifest.contexts.moderation)
    }

    if (manifest.owner && manifest.owner !== graph.key.toString('hex')) {
      await graph.openUserCore(manifest.owner)
    }

    if (manifest.roleBase) {
      await graph.openRoleBase(manifest.roleBase)
      session.noteRoleBaseOpened(manifest.roleBase)
    }

    return sendJson(res, 200, {
      manifestPath,
      openedContexts: session.openedContexts
    })
  }

  if (!graph) return sendJson(res, 400, { error: 'No session open' })

  if (req.method === 'POST' && req.url === '/api/update') {
    await graph.update()
    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'POST' && req.url === '/api/query') {
    const body = await readBody(req)
    const out = await runQueryV0(graph, body)
    return sendJson(res, 200, out)
  }

  if (req.method === 'POST' && req.url === '/api/context/create') {
    const body = await readBody(req)
    const keyHex = await graph.createContext({ writeMode: body.writeMode })
    session.noteContextOpened(keyHex)
    return sendJson(res, 200, { keyHex })
  }

  if (req.method === 'POST' && req.url === '/api/context/open') {
    const body = await readBody(req)
    const ctx = await graph.openContext(body.keyHex, { writeMode: body.writeMode })
    session.noteContextOpened(ctx.key.toString('hex'))
    return sendJson(res, 200, { keyHex: ctx.key.toString('hex') })
  }

  if (req.method === 'GET' && req.url === '/api/contexts') {
    return sendJson(res, 200, { contexts: session.openedContexts })
  }

  if (req.method === 'GET' && req.url.startsWith('/api/context/') && req.url.endsWith('/writers')) {
    const parts = req.url.split('/')
    const keyHex = parts.length >= 5 ? parts[3] : null
    if (!keyHex) return sendJson(res, 400, { error: 'Context key is required' })
    const ctx = await graph.openContext(keyHex)
    session.noteContextOpened(ctx.key.toString('hex'))
    return sendJson(res, 200, { writers: ctx.writerKeys ? ctx.writerKeys() : [] })
  }

  if (req.method === 'POST' && req.url === '/api/rolebase/open') {
    const body = await readBody(req)
    await graph.openRoleBase(body.keyHex)
    session.noteRoleBaseOpened(body.keyHex)
    return sendJson(res, 200, { ok: true })
  }

  // Writes
  if (req.method === 'POST' && req.url === '/api/write/put') {
    const body = await readBody(req)
    const node = await graph.put({ type: body.entityType })
    return sendJson(res, 200, node)
  }

  if (req.method === 'POST' && req.url === '/api/write/content') {
    const body = await readBody(req)
    const out = await graph.putContent(body.entityId, body.body, body.contentType || 'text')
    return sendJson(res, 200, out)
  }

  if (req.method === 'POST' && req.url === '/api/write/relate') {
    const body = await readBody(req)
    const author = body.author || (graph.key ? graph.key.toString('hex') : null)
    const out = await graph.relate({
      from: body.from,
      to: body.to,
      relationType: body.relationType,
      author,
      context: body.contextKey
    })
    return sendJson(res, 200, out)
  }

  if (req.method === 'POST' && req.url === '/api/write/unrelate') {
    const body = await readBody(req)
    const author = body.author || (graph.key ? graph.key.toString('hex') : null)
    const out = await graph.unrelate({
      from: body.from,
      to: body.to,
      relationType: body.relationType,
      author,
      context: body.contextKey
    })
    return sendJson(res, 200, out || { ok: true })
  }

  if (req.method === 'POST' && req.url === '/api/write/tag') {
    const body = await readBody(req)
    const author = body.author || (graph.key ? graph.key.toString('hex') : null)
    const out = await graph.tag(body.entityId, body.tag, { author, context: body.contextKey })
    return sendJson(res, 200, out)
  }

  if (req.method === 'POST' && req.url === '/api/write/untag') {
    const body = await readBody(req)
    const author = body.author || (graph.key ? graph.key.toString('hex') : null)
    const out = await graph.untag(body.entityId, body.tag, { author, context: body.contextKey })
    return sendJson(res, 200, out || { ok: true })
  }

  if (req.method === 'POST' && req.url === '/api/write/contextAddWriter') {
    const body = await readBody(req)
    const ctx = await graph.openContext(body.contextKey, { writeMode: body.writeMode })
    const out = await ctx.addWriter(Buffer.from(body.writerCoreKeyHex, 'hex'), { author: body.author })
    return sendJson(res, 200, out || { ok: true })
  }

  return sendJson(res, 404, { error: 'Not found' })
}

async function createServer (opts = {}) {
  const session = new InspectorSession()

  if (opts.corestoreDir) {
    await session.open(opts.corestoreDir)
  } else if (opts.newDb) {
    await session.newDb({ prefix: 'hypergraph-inspector' })
  }

  const uiDir = opts.uiDir || path.join(__dirname, '..', 'inspector-ui')

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/')) {
        await handleApi(session, req, res)
        return
      }

      const filePath = safeResolveUiPath(uiDir, req.url)
      if (!filePath) return sendText(res, 403, 'Forbidden')

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        return sendText(res, 404, 'Not found')
      }

      const ext = path.extname(filePath).toLowerCase()
      const contentType = ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream'

      const data = fs.readFileSync(filePath)
      res.statusCode = 200
      res.setHeader('content-type', contentType)
      res.setHeader('content-length', data.length)
      res.end(data)
    } catch (err) {
      sendJson(res, 500, { error: err && err.message ? err.message : String(err) })
    }
  })

  return {
    session,
    server,
    listen: (port = 0, host = '127.0.0.1') => new Promise(resolve => {
      server.listen(port, host, () => resolve(server.address()))
    }),
    close: async () => {
      await new Promise(resolve => server.close(resolve))
      await session.close()
    }
  }
}

async function start (opts = {}) {
  const s = await createServer(opts)
  const addr = await s.listen(opts.port || 0, opts.host || '127.0.0.1')
  return { ...s, address: addr }
}

module.exports = {
  createServer,
  start
}
