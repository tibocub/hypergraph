// What hypercore on RocksDB writes: node research/privacy/vault/hypercore-io.js
// Appends small (chat-sized) and large blocks, then reports append rate and
// the files RocksDB leaves (kinds, sizes): the workload a vault would carry.
const fs = require('fs')
const path = require('path')
const os = require('os')
const Corestore = require('corestore')

const dir = fs.mkdtempSync(path.join(process.env.HG_TEST_TMP || os.tmpdir(), 'hc-io-'))
const t = () => Number(process.hrtime.bigint()) / 1e6

function files (d) {
  const out = {}
  for (const f of fs.readdirSync(d, { recursive: true })) {
    const p = path.join(d, f)
    if (!fs.statSync(p).isFile()) continue
    const kind = path.extname(f) || path.basename(f).replace(/-\d+$/, '')
    out[kind] = out[kind] || { n: 0, bytes: 0 }
    out[kind].n++
    out[kind].bytes += fs.statSync(p).size
  }
  return out
}

async function run (name, count, size) {
  const d = path.join(dir, name)
  const store = new Corestore(d)
  const core = store.get({ name })
  await core.ready()
  const block = Buffer.alloc(size, 1)
  let s = t()
  for (let i = 0; i < count; i += 100) await core.append(new Array(Math.min(100, count - i)).fill(block))
  const write = t() - s
  s = t()
  for (let i = 0; i < count; i++) await core.get(i)
  const read = t() - s
  await store.close()
  const f = files(d)
  const total = Object.values(f).reduce((n, x) => n + x.bytes, 0)
  return {
    name,
    appended: `${count} x ${size} B = ${(count * size / 1e6).toFixed(1)} MB`,
    'append (batches of 100)': `${(count / (write / 1000)).toFixed(0)} blocks/s, ${(count * size / 1e6 / (write / 1000)).toFixed(1)} MB/s`,
    'read back': `${(count / (read / 1000)).toFixed(0)} blocks/s`,
    'on disk': `${(total / 1e6).toFixed(1)} MB (${(total / (count * size)).toFixed(2)}x)`,
    files: f
  }
}

;(async () => {
  console.log(JSON.stringify(await run('chat', 20000, 200), null, 2))
  console.log(JSON.stringify(await run('media', 800, 64 << 10), null, 2))
  fs.rmSync(dir, { recursive: true })
})()
