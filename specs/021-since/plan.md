# Plan: `space.since()`

**Branch**: `claude/021-since-ad015a` · **Spec**: [spec.md](spec.md)

No wire, encoding, apply or index-schema change. What it needs is kept already:

- `log.indexed` (`lib/directory.js`, saved in the `@hg/logs` row): every block below it is done. It stops at the lowest
  hole, and a locked block (a private space's key not here) is a hole, so "indexed" is the cursor's bound as it is.
  It is set after the batch's transaction commits.
- `@hg/records` by `{ space, id }`, `id` = log key + seq: one point read per block past the cursor. An edit or
  delete, a rule-rejected, taken-down or banned-out record has no row there: passed for free.

`since()` in `lib/space.js`, in `OPENING`: per held log, from `max(cursor, log.from)` up to `min(log.indexed, log.limit)`, read
the rows, keep what `query()` shows (`NOT_SHOWN`, `gate.mayPut`). A log whose `from` is null isn't read here (big spaces):
no entry, so it counts from its start later. The cursor is copied and only moved forward: an entry ahead of
`log.indexed` (an index being rebuilt, a log not known yet) stays.

`shape()` marks `dropped`: rows without content are returned as they are, since a check must not wait for peers.

Constitution: read-only, Principle I holds by construction (the cursor is local, per device). Test-first (II). One more
method on `Space` and `Scope`, same conventions as `query()`: `TypeError` for bad arguments, `INVALID_TYPE` unless
types are pending (IV).
