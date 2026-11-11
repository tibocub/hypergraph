# Spec 021: `space.since()`: what's new since I last looked (HyperBrowser B7)

**Created**: 2026-11-11 · **Asked by**: HyperBrowser 016 (notifications; design notes in its `research.md` R1, R4, R6) ·
**Status**: done

An app must find every record received since its last check, in a space closed meanwhile, after a restart, later on a
phone waking for seconds. `change` fires only while someone listens, and `Hypergraph.open` opens kept-open spaces before
an app can attach. `query().since()` goes by the authors' stamps: a message written offline and received late is
missed, and a clock far ahead silences what follows. A record id is `{ log, seq }` and a log only grows, so a seq per
log needs no clock. "User" here: a developer calling the API.

## Requirements

- **FR-001** `space.since(cursor | null, { types, limit })` → `{ records, cursor }`. `null`: from now on, `records` empty.
- **FR-002** `records`: created past the cursor, in `query()`'s shape, no promised order. An edit isn't a new record.
  Hypergraph's own types only if named in `types`.
- **FR-003** `cursor`: `{ [log z32]: next seq }`, plain JSON, good across close and reopen of the space and the instance.
  A log it doesn't name counts from its start.
- **FR-004** The cursor only passes what is indexed: a record received but not indexed, not held, or not readable yet
  (`'waiting'`) stays ahead. A record of a type that hasn't arrived yet stays ahead too.
- **FR-005** Deleted, hidden, banned-out, rule-rejected records aren't returned; the cursor passes them.
- **FR-006** `types` filters what is returned; the cursor goes on. `limit`: when reached, the cursor stops there.
- **FR-007** Content dropped here doesn't throw: returned without fields, `dropped: true`.
- **FR-008** Opens a closed space by itself; on a site's handle too.
- **FR-009** Cost follows what is new: no log's core opened.

## Not covered (decided)

The cursor never goes back. A record that starts counting after the cursor passed it isn't returned, though `query()`
shows it: a `put: { permission }` record whose author got the permission later, a record revealed, one refused by a
write limit raised later, a type the app learnt with an update, older periods of a big space read later. Going back would
mean re-reading what was passed on every check, against FR-009, for records that aren't news when they appear.

Big spaces only, the other way: a log not read here yet (`log.from === null`) isn't in the cursor; once reading an
older period reaches it, it counts from `log.from`, so old records come back as new. Kept: skipping it would lose a
new author's recent records.

A block that can't be read holds back the records after it in its log. One number per log can't say "all but that
one"; they arrive late, never lost.

## Tests

`test/next/unit/since.js`, `test/next/net/since.js`, forum scenario `test/next/forum/whats-new.js`,
`perf/scenarios/since.mjs`.
