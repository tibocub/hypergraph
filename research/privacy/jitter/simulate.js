// Can a holder link two identities on one device by when they come online?
//   node research/privacy/jitter/simulate.js
// 500 devices, each with identity A; 100 of them also run a hidden identity B.
// A device comes online ~8 times a day for 14 days; each open identity first
// syncs with holders at session start + network noise (0-2 s, Tor-like) + a
// random delay U(0, D). The observer sees every identity's first-sync times
// (all identities use the same holders: the worst case) and, for each B, ranks
// every A by how often their syncs fall within D + 2 s of each other,
// over what chance predicts. Reported: how many B are linked to their real A.
// shortcut: one observer, uniform sessions; real users have daily rhythms that help the observer.

let seed = 7
const rand = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } // mulberry32
const DAYS = 14; const DAY = 86400; const DEVICES = 500; const HIDDEN = 100; const PER_DAY = 8

function sessions () {
  const out = []
  let t = 0
  for (;;) { t += -Math.log(1 - rand()) * DAY / PER_DAY; if (t > DAYS * DAY) return out; out.push(t) }
}

// Fraction of x's events with a y event within w seconds.
function near (xs, ys, w) {
  let j = 0; let hit = 0
  for (const x of xs) {
    while (j < ys.length && ys[j] < x - w) j++
    if (j < ys.length && ys[j] <= x + w) hit++
  }
  return hit
}

function run (D, onlyBOpen) {
  const A = []; const B = []
  for (let d = 0; d < DEVICES; d++) {
    const s = sessions()
    const sync = (list) => list.map((t) => t + rand() * 2 + rand() * D).sort((a, b) => a - b)
    A.push(sync(s))
    // The hidden identity opens in a fraction of sessions only.
    if (d < HIDDEN) B.push(sync(s.filter(() => rand() < onlyBOpen)))
  }
  const w = D + 2
  let linked = 0
  for (let b = 0; b < HIDDEN; b++) {
    let best = -1; let bestScore = -Infinity
    for (let a = 0; a < DEVICES; a++) {
      const expect = B[b].length * Math.min(1, A[a].length * 2 * w / (DAYS * DAY))
      const score = (near(B[b], A[a], w) - expect) / Math.sqrt(expect + 1e-9)
      if (score > bestScore) { bestScore = score; best = a }
    }
    if (best === b) linked++
  }
  return linked
}

console.log('random delay D | hidden identities linked to their device\'s main identity (of 100), after 14 days')
console.log('               | B open in every session | B open in 1 session of 4')
for (const D of [0, 10, 60, 600, 3600, 4 * 3600]) {
  const label = D < 60 ? D + ' s' : D < 3600 ? D / 60 + ' min' : D / 3600 + ' h'
  console.log(`${label.padStart(14)} | ${String(run(D, 1)).padStart(23)} | ${String(run(D, 0.25)).padStart(24)}`)
}
