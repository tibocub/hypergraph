# Implementation Plan: Data on Relations

**Branch**: `004-relation-data` | **Date**: 2026-10-05 | **Spec**: [spec.md](./spec.md)

## Summary

`relation/create` gains an optional `data` string (≤ 4 KB UTF-8), signed with the relation,
stored on the edge (`e:` value), returned by `edges()` and visible to app rules. A peer can then
list folders with names, addresses and sizes from the context alone — fast-forwarded and fetched
on demand — without opening any author's log.

## Research (decisions)

**R1 — Wire format.** `relation/create` already ends with an always-written `hasValue` flag (and
the float when set). `data` is appended after it as `uint hasData` + `string data`, decoded only
when bytes remain (`state.start < state.end`), the same guard `value` uses. Relations without data
encode exactly as today (no trailing bytes) — pinned by the oplog byte-equality test, extended.
Older decoders stop before the trailing bytes and never see them.

**R2 — Signature.** `stableRelationHash` adds `data` to the signed payload **only when present**,
so every existing relation keeps its digest and signature. An older peer verifying a relation that
carries data computes a digest without it and rejects the relation — acceptable: mixed versions in
a version 2 context are already unsupported (spec 003); the changelog warns version 1 users.

**R3 — Size.** 4,096 bytes of UTF-8, checked in `relate()` / `batch.relate()` (throws) and in
apply (rejects). Bounded because every member of a context may fetch it and it lives in the
index; larger payloads belong in content or behind a content reference.

**R4 — Index.** Stored in the `e:` value (`data`), which `i:in` entries already point at, so both
directions return it with no extra lookups. Counters, `er:`, tags unaffected. Spec 002 P2's
compact layout will carry it as an optional field of the edge value.

**R5 — Updates.** One active edge per (from, type, to): relating an existing active pair again is
ignored, as today. Changing data = `unrelate` + `relate`, which works in one bulk call (delete then
create apply in order).

**R6 — Benchmark.** `bench/scale.js --edge-data`: the writer puts `{ name, root, size }` on each
"in" relation; the joining peer opens only the context and lists folders from edge data.

## Constitution Check

- **I (correctness)**: data is covered by the signature, size-checked and rule-checked in apply,
  identically on every peer; no new merge logic. PASS.
- **II (test-first, encodings tier)**: failing tests first for encoding, signature, apply limits,
  listing, rules, replication. PASS.
- **III**: no new dependency or mechanism. PASS.
- **IV**: `data` is one more option on `relate()` / `batch.relate()`, one more field on edges. PASS.
- **V**: changelog entry; version 1 contexts with older peers must not use data. PASS.
- Doc-sync: `docs/contributors/event-encoding.md`, `docs/contributors/index-structure.md`,
  `docs/querying.md`, `docs/storage-model.md`, `docs/contexts-and-roles.md` (rules see data),
  README, bulk-write contract.

## Project Structure

```text
src/encodings/event.js     relation/create: optional trailing data
src/utils.js               stableRelationHash: data when present
src/batch.js               validateRelateOpts: data type/size
src/hypergraph.js          relate()/batch relate pass data; #relationEvent
src/context-base.js        apply: size check, store data on e:, reader edges include data
test/brittle/core/event-encoding.js, relations.js, bulk-write.js, context-rules.js   extended
test/brittle/replication/fast-forward.js   context-only listing with data
bench/scale.js             --edge-data
```
