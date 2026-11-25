// Starts an I2P router as a child process with its own data folder and SAM on
// localhost, the way an engine would: no install, no service, stopped with it.
//
//   const r = await startRouter('i2pd', exe, dir, { sam: 17656, udp: 17655 })
//   r.samReadyMs          process start -> SAM answers HELLO
//   await r.stop()

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const sam = require('./sam.js')

const ARGS = {
  // i2pd takes everything as flags; the GUI-free part of the Windows build still opens a tray icon.
  i2pd: (dir, { sam: samPort, udp, http, notransit = false, share, bandwidth }) => [
    `--datadir=${dir}`,
    `--conf=${path.join(dir, 'none.conf')}`, // an empty conf: only our flags count
    `--tunconf=${path.join(dir, 'none.conf')}`,
    '--daemon=false', // stay in the foreground so the parent owns the process
    '--log=file', `--logfile=${path.join(dir, 'i2pd.log')}`, '--loglevel=warn',
    '--sam.enabled=true', '--sam.address=127.0.0.1', `--sam.port=${samPort}`, `--sam.portudp=${udp}`,
    `--http.enabled=${http ? 'true' : 'false'}`, `--http.port=${http || 7070}`, '--http.address=127.0.0.1',
    '--httpproxy.enabled=false', '--socksproxy.enabled=false', '--bob.enabled=false',
    '--i2cp.enabled=false', '--i2pcontrol.enabled=false', '--upnp.enabled=false',
    `--notransit=${notransit}`,
    ...(share !== undefined ? [`--share=${share}`] : []),
    ...(bandwidth !== undefined ? [`--bandwidth=${bandwidth}`] : [])
  ],
  // emissary reads [sam] ports from router.toml only.
  emissary: (dir, { notransit = false }) => [
    `--base-path=${dir}`, '--disable-ui', '--disable-upnp', '--disable-nat-pmp',
    ...(notransit ? ['--disable-transit-tunnels'] : [])
  ]
}

function emissaryConfig (dir, { sam: samPort, udp, http }) {
  const f = path.join(dir, 'router.toml')
  if (fs.existsSync(f)) return
  fs.writeFileSync(f, [
    // emissary's own defaults, less the proxies, I2CP, address book and UPnP/NAT-PMP.
    // A section left out turns its feature off: no [reseed] means no reseeding, no [transit] no relaying.
    // IPv6 off: on a host without an IPv6 route, 0.4.0 shuts itself down (exit 0, no error) soon after start.
    'allow_local = false', 'floodfill = false', 'insecure_tunnels = false',
    '[bandwidth]', 'bandwidth = 1000000', 'share_ratio = 0.9',
    '[reseed]', 'reseed_threshold = 25',
    '[transit]', 'max_tunnels = 1000',
    '[ntcp2]', `port = ${samPort + 3}`, 'publish = true', 'ipv4 = true', 'ipv6 = false', 'ml_kem = 4',
    '[ssu2]', `port = ${samPort + 3}`, 'publish = true', 'ipv4 = true', 'ipv6 = false', 'ml_kem = "4,3"',
    '[sam]', `tcp_port = ${samPort}`, `udp_port = ${udp}`, 'host = "127.0.0.1"',
    '[metrics]', `port = ${http}`
  ].join('\n') + '\n')
}

async function startRouter (kind, exe, dir, opts) {
  fs.mkdirSync(dir, { recursive: true })
  if (kind === 'i2pd') fs.writeFileSync(path.join(dir, 'none.conf'), '')
  if (kind === 'emissary') emissaryConfig(dir, opts)
  const started = Date.now()
  const proc = spawn(exe, [...ARGS[kind](dir, opts), ...(opts.extra || [])], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const log = fs.createWriteStream(path.join(dir, 'stdout.log'))
  proc.stdout.pipe(log)
  proc.stderr.pipe(log)
  let exited = null
  proc.once('exit', (code) => { exited = code })
  for (;;) {
    if (exited !== null) throw new Error(`${kind} exited (${exited}), see ${dir}`)
    try { (await sam.control({ port: opts.sam })).socket.destroy(); break } catch {}
    if (Date.now() - started > 120000) { proc.kill(); throw new Error('SAM never answered') }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const samReadyMs = Date.now() - started
  return {
    proc,
    pid: proc.pid,
    samReadyMs,
    samOpts: { port: opts.sam, udp: opts.udp },
    stop: () => new Promise((resolve) => {
      if (exited !== null) return resolve()
      proc.once('exit', resolve)
      proc.kill()
      setTimeout(resolve, 10000)
    })
  }
}

module.exports = { startRouter }
