const test = require('brittle')
const http = require('http')
const { tools } = require('../../../index.js')

function reqJson (port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null

    const req = http.request({
      method,
      host: '127.0.0.1',
      port,
      path,
      headers: data
        ? { 'content-type': 'application/json', 'content-length': data.length }
        : undefined
    }, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', d => { buf += d })
      res.on('end', () => {
        let json = null
        try { json = buf ? JSON.parse(buf) : null } catch (err) {
          return reject(err)
        }

        if (res.statusCode >= 400) {
          return reject(new Error(json && json.error ? json.error : `HTTP ${res.statusCode}`))
        }

        resolve(json)
      })
    })

    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

test('tools: inspector server (meta/query/write)', async (t) => {
  const srv = await tools.inspector.start({ newDb: true, port: 0 })
  t.teardown(async () => srv.close())

  const port = srv.address.port

  const meta = await reqJson(port, 'GET', '/api/meta')
  t.ok(meta.corestoreDir)
  t.ok(meta.key)

  const ctx = await reqJson(port, 'POST', '/api/context/create', { writeMode: 'open' })
  t.ok(ctx.keyHex)

  const post = await reqJson(port, 'POST', '/api/write/put', { entityType: 'post' })
  t.ok(post.id)

  await reqJson(port, 'POST', '/api/write/tag', {
    entityId: post.id,
    tag: 'important',
    contextKey: ctx.keyHex
  })

  await reqJson(port, 'POST', '/api/update', {})

  const q = await reqJson(port, 'POST', '/api/query', {
    scope: { contexts: [ctx.keyHex] },
    query: { type: 'nodeByType', nodeType: 'post', limit: 10 }
  })

  t.ok(q.profile)
  t.ok(typeof q.profile.durationMs === 'number')
  t.is(q.graph.nodes.length, 1)
  t.is(q.graph.nodes[0].id, post.id)
})
