// node check.js <addon.node> <dataDir> [soakSeconds=300]: start the addon, time SAM HELLO and tunnels, soak, stop.
const sam = require('../sam.js')
const [file, dir, soak = 300] = process.argv.slice(2)
const addon = require(require('path').resolve(file))
const PORT = 17656
const t0 = Date.now()
addon.start(dir, PORT)
;(async () => {
  for (;;) { try { (await sam.control({ port: PORT })).socket.destroy(); break } catch { await new Promise((r) => setTimeout(r, 100)) } }
  const helloMs = Date.now() - t0
  const s = await sam.session('STREAM', { sam: { port: PORT } })
  console.log(JSON.stringify({ helloMs, tunnelsReadyMs: s.readyMs, rssMB: Math.round(process.memoryUsage().rss / 1e6) }))
  await new Promise((r) => setTimeout(r, Math.max(0, soak * 1000 - (Date.now() - t0))))
  console.log(JSON.stringify({ soakDone: true, rssMB: Math.round(process.memoryUsage().rss / 1e6), cpuS: process.cpuUsage().user / 1e6 }))
  s.close()
  addon.stop()
  console.log('stopped')
  setTimeout(() => process.exit(0), 500) // the router's threads may linger; this script owns the process
})().catch((e) => { console.error(e); addon.stop(); process.exit(1) })
