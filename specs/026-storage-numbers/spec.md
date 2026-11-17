# Spec 026: each holder's share and use, for members to see

**Created**: 2026-11-17 · **Asked by**: Tibo, grilled 2026-11-17 · **Status**: draft · **With**: HyperBrowser spec 021
(the Members list shows these numbers)

Members can't see how much room their circle has. Each holding device reports its share and how much it holds, so
HyperBrowser can show "0.8/3 GB" per person and a circle's TOTAL. Independent of 025 (holder picking); 025's research
can use the real share sizes.

## Requirements

- **FR-001** `hg/holder` gains `share` (bytes: the device's holding budget, `holding.set`'s `bytes`; 0 when holding is
  off) and `used` (bytes it holds now, as `holding()` reports). Old records without them read as unknown (not 0).
- **FR-002** A holding device rewrites its `hg/holder` in each circle when `share` or `used` moved by 10 % or more since
  its last record, at most once an hour (a share change by the person: at once). The online share keeps its own rule
  (024 FR-008), carried along in the same record.
- **FR-003** The circle's member list (whatever call HyperBrowser's Members uses: the worker finds it) gives, per
  person, `share` and `used` added up over their holding devices' latest records (unknown if none reported), and the
  circle's `total`: the sum of all known shares ÷ 5 (COPIES), approximate (a device's share also serves its other
  circles).
- **FR-004** Docs: what members now learn (each device's budget and use), next to 023/024's "what holders see".

## Tests

- Two members holding: each sees the other's `share` and `used`; a share change shows within one pass; a small `used`
  change (< 10 %) writes no new record; `total` = sum ÷ 5; an old record without the fields reads unknown.

## Not in 026

How holders are picked (025). Per-circle use (the share is one budget per device across circles).
