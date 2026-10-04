# Draft issues for holepunchto/autobase

Found while working on `specs/002-scale-indexing` (research R3, R10). Drafts for the user to file;
nothing has been posted. Versions: autobase 7.28.1 (also checked against 7.28.2 source),
hypercore 11.30.1, corestore 7.9.2, Node 26.4, Windows 10.

---

## 1. `append(array)` encodes the whole array as one value when `valueEncoding` is not binary

**What happens**: `_appendBatch` calls `normalize(this.valueEncoding, value)` before checking
`Array.isArray(value)`, so with any non-binary encoding the array is passed to the encoder as a
single value. With a struct-like codec this throws; with JSON it happens to round-trip (which is
probably why it goes unnoticed). `AppendBatch.flush()` goes through the same path.

**Repro**:

```js
const Autobase = require('autobase')
const Corestore = require('corestore')
const c = require('compact-encoding')

const enc = { // any non-JSON codec
  preencode (s, v) { c.string.preencode(s, v.text) },
  encode (s, v) { c.string.encode(s, v.text) },
  decode (s) { return { text: c.string.decode(s) } }
}
const base = new Autobase(new Corestore('./tmp'), null, {
  valueEncoding: enc,
  open: (store) => store.get('view'),
  apply: async (nodes, view) => { for (const n of nodes) await view.append(Buffer.from(n.value.text)) }
})
await base.ready()
await base.append([{ text: 'a' }, { text: 'b' }])
// throws: The "string" argument must be of type string ... Received undefined
```

(Verified standalone, 2026-10-04.)

**Expected**: each element normalized separately, as `_append` later pushes them separately.
**Suggested fix**: in `_appendBatch`, `if (Array.isArray(value)) value = value.map(v => normalize(enc, v))`.

---

## 2. `append(array, { optimistic: true })` makes apply receive nodes with `value === undefined`

**What happens**: `_appendBatch` sets `this._optimistic = this._appending.length - 1` for an array,
and `_addLocalHeads` then splits the pending values around that index, so nodes reach `apply`
without values. Reproduced with 1,000 values: 998 arrived as `undefined` in `apply`.

**Repro** (observed through hypergraph; this standalone version not yet run): as above but with `valueEncoding: 'binary'`, and
`await base.append(values.map(v => Buffer.from(v)), { optimistic: true })` from an existing writer;
log `node.value` in `apply`.

**Expected**: either reject `optimistic` with an array (optimistic is documented as a
single-block mechanism for non-writers), or apply the flag to the batch as a whole.

---

## 3. Memory spike when a fresh reader finishes catching up a large base

**What happens**: a fresh, non-indexer peer replaying a single-writer base (`fastForward: false`)
with ~250,000 view blocks (one Hyperbee view) peaks at ~2 GB RSS / ~760 MB heap at the moment
catch-up finishes. Memory is flat (~500 MB) during the replay itself. A heap snapshot at the peak
holds ~735,000 in-flight `RocksDBGet`, ~1.4 M promises and ~690,000 generators: hundreds of
thousands of concurrent storage reads, about three per view block. It scales with the view's
size (~3–3.5 GB at ~500,000 blocks).

**Suspected**: `copyPrologue` (hypercore `lib/copy-prologue.js`), called from Autobase's view
migration, reading tree nodes and bitfield pages for the whole prologue with unbounded
parallelism. Not confirmed line by line.

**Repro**: `hypergraph`'s `bench/scale.js` reproduces it end to end
(`MEMLOG=1 FETCH_ONLY=ctx node bench/scale.js 50000`); a standalone Autobase repro is a writer
appending 50,000 batches of Hyperbee puts, then a second store replicating and calling
`update()` once.

**Why it matters**: it caps how large a base a phone or laptop can join from scratch, roughly
linearly in base size.
