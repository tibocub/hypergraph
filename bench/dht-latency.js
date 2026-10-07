// Research measurement (availability, network-wide lookups): how long does
// announcing a topic and finding its announcers take on the public HyperDHT
// (the one Keet and every Holepunch app share)? A topic here stands for a
// file root (SwarmFS) or a piece group's tracker topic.
//
//   node bench/dht-latency.js [--trials N]      (needs internet; light: random topics)
//
// Per trial: node A announces a random topic; node B looks it up until it
// finds A. Also: a lookup of a topic nobody announced (what a miss costs).

const HyperDHT = require('hyperdht')
const crypto = require('crypto')

const argValue = (name, def) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? def : Number(process.argv[i + 1])
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }

async function lookupCount (node, topic) {
  let found = 0
  let replies = 0
  for await (const r of node.lookup(topic)) {
    replies++
    found += r.peers.length
  }
  return { found, replies }
}

async function main () {
  const trials = argValue('--trials', 5)
  const a = new HyperDHT()
  const b = new HyperDHT()
  await a.fullyBootstrapped()
  await b.fullyBootstrapped()
  const keyPair = HyperDHT.keyPair()
  const announce = []
  const lookup = []
  const miss = []
  let foundAll = 0
  for (let i = 0; i < trials; i++) {
    const topic = crypto.randomBytes(32)
    let t0 = Date.now()
    await a.announce(topic, keyPair).finished()
    announce.push(Date.now() - t0)
    t0 = Date.now()
    const r = await lookupCount(b, topic)
    lookup.push(Date.now() - t0)
    if (r.found > 0) foundAll++
    t0 = Date.now()
    await lookupCount(b, crypto.randomBytes(32))
    miss.push(Date.now() - t0)
    await a.unannounce(topic, keyPair).catch(() => {})
  }
  console.log(JSON.stringify({
    trials,
    found: foundAll,
    announceMs: { p50: pct(announce, 0.5), max: Math.max(...announce) },
    lookupMs: { p50: pct(lookup, 0.5), max: Math.max(...lookup) },
    missMs: { p50: pct(miss, 0.5), max: Math.max(...miss) }
  }))
  await a.destroy()
  await b.destroy()
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1) })
