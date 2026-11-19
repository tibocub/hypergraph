# Roadmap

Where hypergraph is going. The dated record of every decision, review and plan behind this page is in
[docs/decisions.md](docs/decisions.md).

## The goal

The easiest kit to build server-less, decentralized social apps (forums, chats, wikis, file sharing,
HyperMD sites) without knowing replication, cryptography or networking.

The app this kit is built for is **HyperBrowser**: a P2P browser where sites live with their owner and
their visitors, and dynamic sites run on a hypergraph space of their own. The libraries stay usable on
their own, on Node and on Bare.

## Done

The new core, `require('hypergraph/next')` (code in `lib/`):

- spaces with members, roles, invites, moderation and app rules, enforced by every reader;
- records with links, edits, deletes, shared editing, relations, tags, queries and live views;
- several devices per person, a personal space, recovery phrases;
- sub-spaces, private spaces encrypted on disk, key rotation, renewing a space, trimming its history;
- public spaces, write limits, packs of public spaces shipped with an app;
- storage budgets and policies, big spaces read from a point in time on;
- many spaces per engine, opened while used; a site's handle for a browser of many sites;
- helpers (blind peers) and circles (people keeping each other's spaces online);
- `space.since(cursor)` for notifications and unread marks;
- `hypergraph/testing` for apps' own tests, the inspector, perf scenarios and soak runs.

The forum scenario tests (`test/next/forum/`) play every flow of a forum through the public API.

## Next

1. **Remove v1.** `src/` (the old `require('hypergraph')`) is frozen until hyperDNS moves to the new core,
   then it goes.
2. **HyperBrowser** (its own repo): the desktop shell, a static site and the forum as sites; then SwarmFS
   inside the engine and a file manager; then friends and messages, Android, iOS.
3. **Availability:** helper machines joining circles, holders picked by how often they are online.
4. **Open questions from SwarmFS:** read-only members (a `read` role?), concurrent versions of a record.
5. **Hardening:** request floods, fake-key floods delaying newcomers, decisions re-read in full.
