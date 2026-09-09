# API Problems (Backlog)

This file is a minimal backlog, not developer documentation and not a place for prose
write-ups — see `CLAUDE.md` and `.specify/memory/constitution.md` ("Documentation &
Specification Hygiene"). Each item below is genuinely still open as of the 2026-09-09
docs/code audit. The moment an item is promoted into a real `/speckit-specify` pass, delete it
from here — don't leave a stale copy.

- **No automatic background replication/sync**: `graph.update()`/`context.update()` are still
  fully manual — nothing polls or listens for remote changes automatically, and
  `graph.on('change')` only fires from inside a caller-triggered `update()`, so it doesn't
  remove the need to call `update()` yourself.
- **No high-level chat/message API**: no `sendMessage()`/`messages()` on `Hypergraph` — apps
  (e.g. `examples/chat-web`) currently hand-roll this on top of `put()`/`relate()`.
- **Bootstrap/export API surface is split in two**: `Hypergraph.export()`/`Hypergraph.join()`
  (context keys + write mode only, no networking) coexist with
  `HypergraphNetwork.generateBootstrap()`/`connectFromBootstrap()` (full networking). Which one
  to use is now documented (`docs/networking.md`), but the duplicate shape itself is unresolved.
- **Inconsistent method placement**: instance vs. static methods, and which class owns which
  concern (`graph.createContext()` vs `Hypergraph.join()` vs `graph.handlePeerConnection()` vs
  `graph.export()`), still isn't unified under one convention (Constitution Principle IV).
