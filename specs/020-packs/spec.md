# Spec 020: packs (HyperBrowser 015)

**Created**: 2026-11-09 · **Asked by**: HyperBrowser 015 (bundled apps) · **Status**: done

HyperBrowser's official apps are public sites whose only publisher goes offline after publishing: a new
install can't open them. HyperBrowser ships them inside the app instead, as their own signed data (same keys),
so they open at once and update from peers. This is hypergraph's part: export and import public spaces.

## Requirements

- **FR-001** `hg.exportSpaces(keys, folder)`: for each public space held here (a sub-space by its own key), its
  decision log's cores (Autobase bootstrap, every writer of its system list, its views) and its accepted logs,
  whole, copied by key into a Corestore of its own in `folder/cores`, and `folder/spaces.json`
  (`{ version: 1, spaces: [{ key, root, cores: [{ key, length }], logs: [key] }] }`). `NOT_ALLOWED` for a space
  that isn't public. No named core is opened in the pack: no key pair, identity, personal space or setting.
- **FR-002** `hg.importSpaces(folder, { timeout })`: the pack's store (opened read only) replicates in process
  with this instance's: every block is checked against its signed tree, as from a peer. Each space is then
  opened, its decisions applied, refused if not public, its listed logs considered (the gate checks each header
  as for a peer's notice), and kept, all or none. A core already held as long or longer is left as is.
- **FR-003** `IMPORT_INVALID` (new code): a list that isn't a pack, blocks missing or changed (the copy breaks,
  or doesn't finish within `timeout`), a space not public. Spaces opened by the failed import are dropped.

## Not done

- No perf scenario: an import runs once per install, not on an app's hot path (ROADMAP: scenarios are app
  flows). A pack of a forum of 5 posts exports and imports in well under a second (test timings).
- A space whose content was dropped here (budgets, story 6) can't be exported whole: the export waits for
  blocks nobody serves and fails after `timeout`.

## Tests

`test/next/forum/bundled.js` (forum scenario): packed forum read with the owner offline; a post made after
packing arrives; the importer posts; an older pack keeps newer posts; a changed pack and a pack naming more
blocks than it holds are refused with nothing kept; a forum that isn't public isn't packed; no secret in a pack.
