# TODO (Backlog)

This file is a minimal backlog, not developer documentation and not a place for prose
write-ups — see `CLAUDE.md` and `.specify/memory/constitution.md` ("Documentation &
Specification Hygiene"). Each item below is genuinely still open as of the 2026-09-09
docs/code audit. The moment an item is promoted into a real `/speckit-specify` pass, delete it
from here — don't leave a stale copy.

- **Wire JSDoc type checking into CI**: `jsconfig.json` (`checkJs`, `strict`) exists and gives
  editor-level checking, but nothing runs `tsc --noEmit` (or equivalent) as part of `npm test`
  or CI, so type errors aren't actually enforced.
- **Auth middleware example for HTTP APIs**: `graph.can()` exposes the primitive permission
  check; no packaged Express/HTTP middleware example exists yet for apps that want to gate
  routes on it.
- **Batch operations, the rest**: `graph.batch()` covers `put`/`putContent`/`putContentRef`/
  `relate` (spec 002); `unrelate`/`tag`/`untag`/`del` still have no bulk form.
- **Broader statistics/metrics**: `query().count()` exists; nothing beyond that (storage size,
  replication/peer stats, per-type counts without a full scan).
- **Per-context cleanup**: `Hypergraph`'s teardown (`_close()`) correctly tears down every open
  context/user-core/role-base/scope-base as a whole; there's no API to remove/prune a single
  context or evict a single user-core without closing the whole graph.
