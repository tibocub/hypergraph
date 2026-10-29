# Tasks: Helpers (013)

- [x] T001 Move `blind-peering` to dependencies (package.json)
- [x] T002 [test] `test/next/unit/helpers-encoding.js`: settings/set with/without helpers round-trips; logs/list round-trips
- [x] T003 [test] `test/next/net/helpers.js`: stories 1–4 (fail first)
- [x] T004 [test] `test/next/forum/helpers.js` + `forum.js` helpers (setHelpers, keptBy)
- [x] T005 Encoding: trailing `helpers` on settings/set; `logs/list` decision (lib/encodings.js)
- [x] T006 Apply + state: owner-only helpers in meta; `listed:` entries; State.listed (lib/decisions/*)
- [x] T007 `lib/helpers.js`: blind-peering client per space, background only
- [x] T008 Space: setHelpers, helpers, hand over logs, list logs, consider listed logs, close (lib/space.js)
- [x] T009 Start helpers once the swarm exists (lib/network.js)
- [x] T010 Docs: docs/next/api.md, concepts.md; CHANGELOG.md (ROADMAP status line left to the lead)
- [x] T011 Run test:next, test:next:bare, v1 npm test (SwarmFS not run: it links the main checkout, not this branch)
