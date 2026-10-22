// The write limit of an open space (story 9, T071a; research.md A8, A14):
// `{ records, periodMs }`: a device's log counts at most `records` records
// within any `periodMs`. Every member must judge each record the same way,
// although deletes and take-downs wipe earlier records (whose stamps a
// newcomer never sees). So a record at block `seq` counts if `seq` is at most
// `records`, or if the first readable block from `seq - records` on is
// stamped at least `periodMs` before it. A wiped block takes the stamp of the
// next readable one: deleting never frees room, and every member, whatever it
// held before the wipe, judges alike once it knows of the wipe.

const { WIPED } = require('./activity.js')

// 'ok' | 'over' | 'wait' (a block the judgment needs isn't here yet).
// `at(i)`: block i's stamp, WIPED, or null (async).
async function judge (seq, stamp, limit, at) {
  if (!limit || seq <= limit.records) return 'ok'
  for (let i = seq - limit.records; i < seq; i++) {
    const s = await at(i)
    if (s === null || s === undefined) return 'wait'
    if (s === WIPED) continue
    return stamp - s >= limit.periodMs ? 'ok' : 'over'
  }
  return 'over'
}

// When this log may write again under `limit`: the earliest stamp its next
// record (block `seq`) would count with, or 0 if it counts now.
async function nextAllowed (seq, stamp, limit, at) {
  if (!limit || seq <= limit.records) return 0
  for (let i = seq - limit.records; i < seq; i++) {
    const s = await at(i)
    if (s === null || s === undefined || s === WIPED) continue
    return stamp - s >= limit.periodMs ? 0 : s + limit.periodMs
  }
  return Infinity
}

// Is this a valid limit? { records: whole number ≥ 1, periodMs: ms ≥ 1 }.
function validLimit (l) {
  return !!l && Number.isInteger(l.records) && l.records >= 1 && Number.isInteger(l.periodMs) && l.periodMs >= 1
}

module.exports = { judge, nextAllowed, validLimit }
