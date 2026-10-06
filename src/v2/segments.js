// Time segments of a channel (spec 007, research R4): fixed slices of the
// channel's segment length, by the author's claimed time. No record per
// segment exists anywhere but in rosters.

const FUTURE_MS = 5 * 60 * 1000 // a message claiming a later time waits until then

const segmentOf = (t, segmentMs) => Math.floor(t / segmentMs)
const segmentStart = (segment, segmentMs) => segment * segmentMs
const isFuture = (t, now = Date.now()) => t > now + FUTURE_MS

module.exports = { segmentOf, segmentStart, isFuture, FUTURE_MS }
