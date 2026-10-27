// Plain HyperDHT only (hyperdht #304): two processes
// on the same machine, local testnet, N fresh DHT nodes each, every node
// listening. Node i of each process connects to node i of the other at the
// same moment (as two Hyperswarm peers finding each other on a topic do),
// writes one byte and waits for the echo. A connection the client sees open
// but whose byte is never echoed is one the server never got.
//
//   node hyperdht-lan-race.js [pairs=10] [--one-way]
//
// --one-way: only the first process dials (no simultaneous dials).

const { spawn } = require('child_process')
const DHT = require('hyperdht')
const b4a = require('b4a')

const ONE_WAY = process.argv.includes('--one-way')
const args = process.argv.filter((a) => a !== '--one-way')

if (args[2] === '--peer') peer(JSON.parse(args[3]), Number(args[4]), args[5] === 'dial')
else main(Number(args[2]) || 10)

async function main (n) {
  const testnet = await require('hyperdht/testnet')(3)
  const bootstrap = JSON.stringify(testnet.bootstrap)
  const procs = [0, 1].map((i) => spawn(process.execPath, [__filename, '--peer', bootstrap, String(n), i === 0 || !ONE_WAY ? 'dial' : 'listen'], { stdio: ['pipe', 'pipe', 'inherit'] }))
  const lines = procs.map((p) => {
    let out = ''
    const waiters = []
    p.stdout.on('data', (d) => {
      out += d
      let i
      while ((i = out.indexOf('\n')) !== -1) {
        const line = out.slice(0, i)
        out = out.slice(i + 1)
        waiters.shift()(line)
      }
    })
    return () => new Promise((resolve) => waiters.push(resolve))
  })
  const keys = await Promise.all(lines.map((next) => next()))
  procs[0].stdin.write(keys[1] + '\n') // each gets the other's keys: both dial now
  procs[1].stdin.write(keys[0] + '\n')
  const results = await Promise.all(lines.map((next, i) => (i === 0 || !ONE_WAY ? next() : null)))
  console.log(`${ONE_WAY ? 'one way' : 'both ways at once'}: ${results.filter(Boolean).join('; ')}`)
  for (const p of procs) p.kill()
  await testnet.destroy()
}

async function peer (bootstrap, n, dial) {
  const nodes = []
  for (let i = 0; i < n; i++) {
    const dht = new DHT({ bootstrap })
    const s = dht.createServer((conn) => {
      conn.on('error', () => {})
      conn.on('data', (d) => conn.write(d))
    })
    await s.listen()
    nodes.push({ dht, key: b4a.toString(s.publicKey, 'hex') })
  }
  process.stdout.write(nodes.map((x) => x.key).join(',') + '\n')
  const theirs = await new Promise((resolve) => process.stdin.once('data', (d) => resolve(d.toString().trim().split(','))))
  if (!dial) return
  let open = 0
  let echoed = 0
  await Promise.all(nodes.map(async ({ dht }, i) => {
    const conn = dht.connect(b4a.from(theirs[i], 'hex'))
    conn.on('error', () => {})
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000)
      conn.on('open', () => {
        open++
        conn.write(b4a.from([i]))
      })
      conn.once('data', () => {
        clearTimeout(timer)
        resolve(true)
      })
      conn.on('close', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    if (ok) echoed++
    conn.destroy()
  }))
  process.stdout.write(`${n} dials: ${open} opened, ${echoed} echoed, ${open - echoed} open but dead\n`)
}
