#!/usr/bin/env node

const path = require('path')
const { tools } = require('../src/hypergraph')

function parseArgs (argv) {
  const out = { dir: null, port: 0, host: '127.0.0.1', newDb: false }

  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--port') out.port = Number(args[++i] || 0)
    else if (a === '--host') out.host = String(args[++i] || '127.0.0.1')
    else if (a === '--new') out.newDb = true
    else if (!out.dir) out.dir = a
  }

  return out
}

;(async () => {
  const opts = parseArgs(process.argv)

  const corestoreDir = opts.dir ? path.resolve(opts.dir) : null
  const srv = await tools.inspector.start({
    corestoreDir,
    newDb: opts.newDb || !corestoreDir,
    port: opts.port,
    host: opts.host
  })

  const url = `http://${opts.host}:${srv.address.port}`
  process.stdout.write(`Hypergraph inspector running at ${url}\n`)
})().catch(err => {
  process.stderr.write((err && err.stack) ? err.stack + '\n' : String(err) + '\n')
  process.exit(1)
})
