// Temp folders on E: (C: is nearly full), removed after each run.
const fs = require('fs')
const path = require('path')
const ROOT = process.env.HG_SCALE_TMP || 'E:/Code/P2P/.tmp/scale-audit'
function tmpDir (name) {
  fs.mkdirSync(ROOT, { recursive: true })
  return fs.mkdtempSync(path.join(ROOT, name + '-'))
}
function rm (dir) { fs.rmSync(dir, { recursive: true, force: true }) }
const mb = (n) => (n / 1048576).toFixed(1) + ' MB'
function mem () {
  if (global.gc) { global.gc(); global.gc() }
  const m = process.memoryUsage()
  return { heap: m.heapUsed, rss: m.rss, ext: m.external + m.arrayBuffers }
}
module.exports = { tmpDir, rm, mb, mem }
