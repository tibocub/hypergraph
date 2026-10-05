---

description: "Tasks for 004-relation-data"
---

# Tasks: Data on Relations

**Tests first** for every `src/` change (encodings and apply: non-negotiable tier).

## Phase 1: Foundational (encoding + signature)

- [X] T001 Test first in `test/brittle/core/event-encoding.js`: `relation/create` with `data` round-trips (with and without `value`); without `data` the bytes are identical to before (extend the oplog byte-equality fixture); an event encoded with data decodes on the old field set when the trailing bytes are cut (old-decoder simulation)
- [X] T002 `src/encodings/event.js`: trailing `uint hasData` + `string data` after the value fields, decoded only when bytes remain
- [X] T003 Test first in `test/brittle/core/relations.js`: `stableRelationHash` unchanged for a relation without data; a relation whose data was altered after signing is rejected at apply
- [X] T004 `src/utils.js`: include `data` in the signed payload only when present

## Phase 2: US1 + US2 — write, store, list, check

- [X] T005 [US1] Test first in `test/brittle/core/relations.js`: `relate({ data })` — `edges()` out and in return the data; relations without data have no `data` field; `unrelate` removes it; unrelate + relate in one `graph.batch()` replaces it (US3)
- [X] T006 [US2] Test first in `test/brittle/core/relations.js`: `relate()` / `batch.relate()` throw for non-string or > 4,096-byte data; a raw oversized relation is rejected at apply
- [X] T007 [US2] Test first in `test/brittle/core/context-rules.js`: a rule sees `event.data`, and `reader.edges()` returns existing edges' data ("names unique in a folder" rule rejects a duplicate name)
- [X] T008 `src/batch.js` (`validateRelateOpts`: data string ≤ 4,096 bytes), `src/hypergraph.js` (`relate` / batch pass `data` to `#relationEvent`), `src/context-base.js` (apply: reject oversized/non-string data; store `data` on the `e:` value; reader `edges()` includes it)
- [X] T009 [US1] Test first in `test/brittle/replication/fast-forward.js`: a fresh peer that opens only the context (no user core) fast-forwards and lists a folder with every entry's data; the writer's user core is not in its store

## Phase 3: Benchmark and polish

- [X] T010 `bench/scale.js --edge-data`: writer puts `{ name, root, size }` on "in" relations (and still writes the content reference); joiner opens only the context and lists via edge data; run 100k and 1M; record in `bench/README.md` (SC-001, SC-002)
- [X] T011 Docs: `docs/contributors/event-encoding.md`, `docs/contributors/index-structure.md`, `docs/querying.md`, `docs/storage-model.md`, `docs/contexts-and-roles.md`, README, `specs/002-scale-indexing/contracts/bulk-write.md` (`data` on `batch.relate`)
- [X] T012 CHANGELOG; `npm test`, HyperBBS, hyperDNS
