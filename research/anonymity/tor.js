// Runs a local `tor` (the C tor of the Tor Expert Bundle) and dials through
// its SOCKS port. No npm dependency: SOCKS5 CONNECT is a few bytes.

const { spawn } = require('child_process')
const fs = require('fs')
const net = require('net')
const path = require('path')

// Starts tor in `dir`. With `servicePort`, also an onion service whose port
// 7000 forwards to 127.0.0.1:servicePort. Resolves once bootstrapped.
async function startTor (torPath, dir, { socksPort, servicePort = 0, timeout = 180000 }) {
  fs.mkdirSync(dir, { recursive: true })
  const torrc = [
    `DataDirectory ${path.join(dir, 'data')}`,
    `SocksPort 127.0.0.1:${socksPort}`,
    'ClientOnly 1', // never a relay
    'AvoidDiskWrites 1'
  ]
  if (servicePort) {
    const hs = path.join(dir, 'hs')
    torrc.push(`HiddenServiceDir ${hs}`, `HiddenServicePort 7000 127.0.0.1:${servicePort}`)
  }
  fs.writeFileSync(path.join(dir, 'torrc'), torrc.join('\n') + '\n')
  const proc = spawn(torPath, ['-f', path.join(dir, 'torrc')], { stdio: ['ignore', 'pipe', 'pipe'] })
  const started = Date.now()
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tor did not bootstrap in time')), timeout)
    let buf = ''
    proc.stdout.on('data', (d) => {
      buf += d
      if (/Bootstrapped 100%/.test(buf)) { clearTimeout(timer); resolve() }
    })
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`tor exited (${code}): ${buf.slice(-500)}`)) })
  })
  const bootstrapMs = Date.now() - started
  const onion = servicePort ? fs.readFileSync(path.join(dir, 'hs', 'hostname'), 'utf8').trim() : null
  return { proc, onion, bootstrapMs, stop: () => proc.kill() }
}

// A TCP socket to host:port through the SOCKS5 proxy (the name is resolved by
// tor, never locally: a local lookup of an onion name would leak it).
function socksConnect (socksPort, host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(socksPort, '127.0.0.1')
    let step = 0
    let buf = Buffer.alloc(0)
    s.once('error', reject)
    s.on('connect', () => s.write(Buffer.from([5, 1, 0]))) // v5, one method: no auth
    s.on('data', function ondata (d) {
      buf = Buffer.concat([buf, d])
      if (step === 0 && buf.length >= 2) {
        if (buf[1] !== 0) return fail('no acceptable auth method')
        buf = buf.subarray(2)
        step = 1
        const name = Buffer.from(host)
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]))
      }
      if (step === 1 && buf.length >= 10) {
        if (buf[1] !== 0) return fail(`socks reply ${buf[1]}`) // 4: host unreachable (descriptor not yet found)
        s.removeListener('data', ondata)
        s.removeListener('error', reject)
        resolve(s) // tor answers with an IPv4 bound address: 10 bytes, nothing after
      }
    })
    function fail (msg) { s.destroy(); reject(new Error(msg)) }
  })
}

module.exports = { startTor, socksConnect }
