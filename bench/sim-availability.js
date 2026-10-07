// Research simulation (availability): can members who come and go keep every
// piece of a community's data online, without anyone holding everything?
// No network: one process, simulated minutes.
//
//   node bench/sim-availability.js [--members N] [--pieces P] [--days D] [--seed S]
//
// Members alternate online/offline sessions (exponential; casual members
// online ~25% of the time, helpers ~95%). A piece is held by the members who
// downloaded it; they keep it while offline (disk). Placement and repair
// candidates are ranked per piece by a hash of (member, piece) — rendezvous
// hashing: everyone computes the same order without talking.
//
// Policies, per piece:
//   eager(k)       keep >= k holders online; repair as soon as fewer
//   lazy(t, K)     count every holder (online or not); repair only when fewer
//                  than t are online, up to K holders in all (Carbonite-style:
//                  people come back)
// Coordination of a repair:
//   rank           candidates act in rank order, each after rank * slot + a
//                  random jitter, re-checking first (announce on start)
//   none           every online member that notices the deficit copies it
//
// A repair copies the whole piece from an online holder at the member's
// upload rate; it fails if no holder is online when it would complete.
// Reported: availability (share of piece-minutes with >= 1 holder online),
// repair traffic per member per day, storage per member, duplicate copies.

const crypto = require('crypto')

const argValue = (name, def) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? def : Number(process.argv[i + 1])
}

// Deterministic PRNG (mulberry32).
function rng (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const exp = (rand, mean) => -Math.log(1 - rand()) * mean

// Rendezvous score of member m for piece j (higher = earlier in the order).
function score (m, j) {
  const h = crypto.createHash('sha1').update(`${m}:${j}`).digest()
  return h.readUInt32BE(0)
}

function simulate ({ members, pieces, days, pieceMB, uploadMBps, helpers, policy, coordination, seed, slot, jitter, announceLatency, helperCopies = 0, trimAt = 0, casualOn = 60, casualOff = 180 }) {
  const rand = rng(seed)
  const minutes = days * 24 * 60
  const M = []
  for (let i = 0; i < members; i++) {
    const helper = i < helpers
    // Casual: online ~1 h, offline ~3 h (25%). Helpers: online ~19 h, offline ~1 h (95%).
    const on = helper ? 19 * 60 : casualOn
    const off = helper ? 60 : casualOff
    const online = rand() < on / (on + off)
    M.push({ helper, on, off, online, next: exp(rand, online ? on : off), held: new Set(), uploadedMB: 0, downloadedMB: 0 })
  }
  // Initial placement: each piece on its K (or k) highest-ranked members.
  const initial = policy.kind === 'eager' ? policy.k : policy.K
  const P = []
  for (let j = 0; j < pieces; j++) {
    const order = []
    for (let m = 0; m < members; m++) order.push(m)
    // Only rank a sample for speed: rendezvous over all members is the same
    // order; a partial sort of a random sample is a fair stand-in here.
    order.sort((a, b) => score(b, j) - score(a, j))
    const holders = new Set(order.slice(0, initial))
    // A helper group: each piece also on `helperCopies` of the helpers, by
    // rendezvous among the helpers only (IPFS Cluster's replication factor).
    if (helperCopies) {
      const hs = []
      for (let h = 0; h < helpers; h++) hs.push(h)
      hs.sort((a, b) => score(b, j) - score(a, j))
      for (const h of hs.slice(0, helperCopies)) holders.add(h)
    }
    for (const m of holders) M[m].held.add(j)
    P.push({ holders, order, pending: new Map(), availableMinutes: 0 })
  }
  const transferMinutes = Math.max(1, Math.ceil(pieceMB / uploadMBps / 60))
  let repairs = 0
  let duplicates = 0
  let failed = 0
  let trims = 0

  const onlineHolders = (p) => { let n = 0; for (const m of p.holders) if (M[m].online) n++; return n }
  const want = (p) => {
    const online = onlineHolders(p) + [...p.pending.values()].filter(x => x.started).length
    if (policy.kind === 'eager') return Math.max(0, policy.k - online)
    if (onlineHolders(p) >= policy.t) return 0
    return Math.max(0, Math.min(policy.t - online, policy.K + policy.t - p.holders.size))
  }

  for (let now = 0; now < minutes; now++) {
    // Sessions.
    for (let i = 0; i < members; i++) {
      const m = M[i]
      if (now < m.next) continue
      m.online = !m.online
      m.next = now + exp(rand, m.online ? m.on : m.off)
    }
    // Pieces: availability, decide repairs, complete transfers.
    for (let j = 0; j < pieces; j++) {
      const p = P[j]
      const online = onlineHolders(p)
      if (online > 0) p.availableMinutes++
      // Complete or drop transfers.
      for (const [m, x] of p.pending) {
        if (!x.started) {
          if (now < x.at) continue
          // Its turn: re-check (rank coordination sees started transfers).
          if (!M[m].online || p.holders.has(m) || (coordination === 'rank' && want(p) <= 0 && x.rank > 0)) { p.pending.delete(m); continue }
          x.started = true
          x.done = now + transferMinutes
          continue
        }
        if (now < x.done) continue
        p.pending.delete(m)
        if (!M[m].online || onlineHolders(p) === 0) { failed++; continue }
        if (p.holders.has(m)) continue
        // A copy beyond what the policy wanted when it landed is a duplicate.
        const enough = policy.kind === 'eager' ? onlineHolders(p) >= policy.k : onlineHolders(p) >= policy.t
        if (enough) duplicates++
        p.holders.add(m)
        M[m].held.add(j)
        M[m].downloadedMB += pieceMB
        repairs++
      }
      // Trim: past `trimAt` holders with enough online, the lowest-ranked
      // offline casual holder drops its copy (bounded storage).
      if (trimAt && p.holders.size > trimAt && want(p) <= 0) {
        for (let r = p.order.length - 1; r >= 0; r--) {
          const m = p.order[r]
          if (!p.holders.has(m) || M[m].online || M[m].helper) continue
          p.holders.delete(m)
          M[m].held.delete(j)
          trims++
          break
        }
      }
      const deficit = want(p)
      if (deficit <= 0 || online === 0) continue
      if (coordination === 'rank') {
        // The best-ranked online non-holders, each after its slot + jitter.
        let rank = 0
        for (const m of p.order) {
          if (rank >= deficit + 2) break // a couple of backups behind the ones needed
          if (!M[m].online || p.holders.has(m) || p.pending.has(m)) continue
          p.pending.set(m, { rank, at: now + rank * slot + Math.floor(rand() * jitter), started: false })
          rank++
        }
      } else {
        // Every online non-holder that notices this minute (1 in 10) copies.
        for (let m = 0; m < members; m++) {
          if (!M[m].online || p.holders.has(m) || p.pending.has(m)) continue
          if (rand() < 0.1 / members * 50) p.pending.set(m, { rank: 0, at: now + Math.floor(rand() * announceLatency), started: false })
        }
      }
    }
  }

  const totalHeld = M.reduce((n, m) => n + m.held.size, 0)
  const casual = M.filter(m => !m.helper)
  return {
    availability: P.reduce((n, p) => n + p.availableMinutes, 0) / (pieces * minutes),
    piecesEverLost: P.filter(p => p.availableMinutes < minutes).length,
    repairMBPerMemberDay: (repairs * pieceMB) / members / days,
    storedMBPerMember: totalHeld * pieceMB / members,
    maxStoredMBCasual: Math.max(...casual.map(m => m.held.size)) * pieceMB,
    copiesPerPiece: totalHeld / pieces,
    repairs,
    duplicates,
    failed,
    trims
  }
}

function main () {
  const base = {
    members: argValue('--members', 300),
    pieces: argValue('--pieces', 1000),
    days: argValue('--days', 3),
    seed: argValue('--seed', 1),
    uploadMBps: 1,
    slot: 2,
    jitter: 2,
    announceLatency: 2,
    casualOn: argValue('--on', 60), // minutes online per session (casual members)
    casualOff: argValue('--off', 180)
  }
  const runs = [
    { name: 'eager k=3, rank', policy: { kind: 'eager', k: 3 }, coordination: 'rank', helpers: 0, pieceMB: 4 },
    { name: 'eager k=3, none', policy: { kind: 'eager', k: 3 }, coordination: 'none', helpers: 0, pieceMB: 4 },
    { name: 'lazy t=2 K=6, rank', policy: { kind: 'lazy', t: 2, K: 6 }, coordination: 'rank', helpers: 0, pieceMB: 4 },
    { name: 'lazy t=1 K=6, rank', policy: { kind: 'lazy', t: 1, K: 6 }, coordination: 'rank', helpers: 0, pieceMB: 4 },
    { name: 'eager k=3, rank, 64 MB', policy: { kind: 'eager', k: 3 }, coordination: 'rank', helpers: 0, pieceMB: 64 },
    { name: 'eager k=3, rank, 3 helpers', policy: { kind: 'eager', k: 3 }, coordination: 'rank', helpers: 3, pieceMB: 4 },
    { name: 'lazy t=2 K=6, rank, 3 helpers', policy: { kind: 'lazy', t: 2, K: 6 }, coordination: 'rank', helpers: 3, pieceMB: 4 },
    { name: 'eager k=3, trim 12', policy: { kind: 'eager', k: 3 }, coordination: 'rank', helpers: 0, pieceMB: 4, trimAt: 12 },
    { name: 'helpers 2-of-3 only', policy: { kind: 'lazy', t: 0, K: 0 }, coordination: 'rank', helpers: 3, helperCopies: 2, pieceMB: 4 },
    { name: 'helpers 2-of-3 + eager k=2, trim 8', policy: { kind: 'eager', k: 2 }, coordination: 'rank', helpers: 3, helperCopies: 2, pieceMB: 4, trimAt: 8 },
    { name: 'helpers 2-of-3 + lazy t=2 K=4', policy: { kind: 'lazy', t: 2, K: 4 }, coordination: 'rank', helpers: 3, helperCopies: 2, pieceMB: 4 }
  ]
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
  for (const r of runs) {
    if (only && !r.name.includes(only)) continue
    const t0 = Date.now()
    const out = simulate({ ...base, ...r })
    console.log(JSON.stringify({ run: r.name, ...Object.fromEntries(Object.entries(out).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(5) : v])), ms: Date.now() - t0 }))
  }
}

main()
