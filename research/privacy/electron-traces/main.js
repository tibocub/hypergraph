// What an Electron session writes to disk. Run with Electron:
//   electron research/privacy/electron-traces/main.js <out-dir> memory|persist [--no-shader-cache]
// A page on a local server uses cookies, storage, IndexedDB, Cache API, a
// service worker, the HTTP cache, a 30 MB blob and WebGL, each holding MARKER.
// Then check.js lists what landed on disk and which files hold the marker.
const { app, BrowserWindow, session } = require('electron')
const http = require('http')
const path = require('path')
const fs = require('fs')

const [out, mode, flag] = process.argv.slice(2).filter((a) => !a.startsWith('--inspect') && a !== __filename && a !== '.')
fs.mkdirSync(out, { recursive: true })
app.setPath('userData', path.join(out, 'userData'))
app.setPath('temp', path.join(out, 'temp'))
app.setPath('crashDumps', path.join(out, 'crashDumps'))
if (flag === '--no-shader-cache') app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

const MARKER = 'MARKER029' + 'XYZZY' // split: this file itself must not match

const page = `<!doctype html><title>run</title><script>
(async () => {
  const M = '${MARKER}'
  document.cookie = 'c=' + M + '; max-age=86400'
  localStorage.setItem('k', M); sessionStorage.setItem('k', M)
  await new Promise((res) => { const r = indexedDB.open('db', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { const tx = r.result.transaction('s', 'readwrite'); tx.objectStore('s').put(M.repeat(1000), 'k'); tx.oncomplete = res } })
  const c = await caches.open('c'); await c.put('/x', new Response(M))
  await navigator.serviceWorker.register('/sw.js')
  await fetch('/big').then((r) => r.text())
  const blob = new Blob([M.repeat(2e6)]); window.keep = blob; await blob.text()
  const gl = document.createElement('canvas').getContext('webgl')
  const sh = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(sh, '// ' + M + '\\nvoid main(){gl_FragColor=vec4(1.0);}'); gl.compileShader(sh)
  const p = gl.createProgram(); const v = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(v, 'void main(){gl_Position=vec4(0.0);}'); gl.compileShader(v)
  gl.attachShader(p, v); gl.attachShader(p, sh); gl.linkProgram(p); gl.useProgram(p); gl.drawArrays(gl.POINTS, 0, 1); gl.finish()
  console.log(M) // console messages: do they reach a log file?
  document.title = 'done'
})().catch((e) => { document.title = 'error ' + e.message })
</script>`

const server = http.createServer((req, res) => {
  if (req.url === '/sw.js') { res.setHeader('content-type', 'text/javascript'); return res.end(`// ${MARKER}\nself.addEventListener('fetch', () => {})`) }
  if (req.url === '/big') { res.setHeader('cache-control', 'max-age=86400'); return res.end(MARKER.repeat(50000)) }
  res.setHeader('content-type', 'text/html'); res.end(page)
})

app.whenReady().then(() => server.listen(0, '127.0.0.1', () => {
  const ses = session.fromPartition((mode === 'persist' ? 'persist:' : '') + 'site-test')
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses } })
  win.on('page-title-updated', (e, title) => {
    if (title === 'run') return
    console.log('page:', title)
    setTimeout(() => { win.close(); server.close(); app.quit() }, 3000)
  })
  win.loadURL(`http://127.0.0.1:${server.address().port}/`)
}))
