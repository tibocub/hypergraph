# HyperBrowser milestone 1: design

Grilled with Tibo 2026-11-06. Builds on ROADMAP.md "The final app: HyperBrowser" (2026-11-01), which stays the
source for layers, sandbox rules, storage and availability; this file says what milestone 1 is and how it starts.

## Intent

HyperBrowser is the app the libraries exist for: a P2P browser whose sites live with their owner and visitors.
Milestone 1 proves it on the desktop with two real sites that stay part of the final product:

- **the official HyperBrowser site** (a static hypersite): user documentation and project news. Also published on
  the normal web (GitHub Pages) from the same source.
- **the official HyperBrowser forum** (a dynamic hypersite on hypergraph): the project's public forum at release;
  until then our real-life reliability test.

The forum example (`hypergraph-forum-example`) stays what it is: small code showing how to build on hypergraph. It
is not the official forum and is not ported into HyperBrowser.

## Goals

1. A desktop shell on Pear (`pear-runtime`), Windows and Linux, both tested by Tibo. macOS: built if it comes
   almost free, labeled "not tested".
2. One engine (Bare) owning identity, swarm, spaces; sites never run in it.
3. Sites open by key; a built-in bookmark list with the official site and forum preset.
4. Each site in its own sandboxed web view: no Node, no file system, no other site's data.
5. A dynamic site's JS gets the hypergraph API for its own space (async, by messages). A static site may use JS
   but gets no hypergraph API.
6. HyperMD → HTML in the HyperMD repo, used both by the shell (to show pages) and by `hypermd build <folder>`
   (a static hypersite → a plain HTML site, Hugo-like).
7. The official site on GitHub Pages from `hypermd build` (Tibo pushes).
8. User docs drafted by workers as each feature lands, edited by Tibo (doc-sync rule).

## Non-goals (milestone 1)

- hyperDNS names (later; it only maps names to keys, so keys-only now loses nothing).
- Developer docs site (another HTTP site plus `.md` in the repos; later).
- Android / iOS (milestone 3), push wake-ups, helper servers (Tibo sets up VPS / home-server helpers after
  testing; until then his machines, with the app left running in the tray, keep things online).
- Features beyond what the forum scenario tests cover.
- File manager, friends, messages (milestones 2–3).

## Anti-goals

- A forum that copies today's web trends. Tibo has specific tastes; **no forum UI is designed or built before a
  forum talk with Tibo, then mockups he approves** (he may bring his own, e.g. from Figma's AI).
- Site code running in the engine, or a site reaching the engine's stream directly.
- Dropping Pear at the first difficulty: Pear is battle-tested by Keet. Plain Electron + Bare is a fallback only
  for a confirmed blocker, decided with Tibo.
- A public official forum during testing (a public space can't be made private again).

## Decided

- **Repo**: `E:\Code\P2P\HyperBrowser` (new, own git repo; Tibo creates the GitHub remote and pushes). Layout:
  `engine/` (the Bare engine, with a windowless mode the helpers will run later), the shell, `sites/home`,
  `sites/forum`. Sites stay in this repo until the site API holds still.
- **Mobile-ready boundary** (from react-native-bare-kit / bare-expo, read 2026-11-06: on mobile the UI is React
  Native and the engine a Bare worklet; no Pear, no WebView in those repos):
  - the engine is a worker with one entry, `start(ipc)`, over a duplex byte stream; Bare modules only (no Node
    builtins, no Electron / Pear calls); config arrives as messages, not env or globals. Packable with bare-stow.
  - our own versioned, framed message protocol on that stream (requests with ids, replies, events). The shell
    turns it into the site API.
  - site views behind one shell interface (desktop: Pear/Electron views; mobile later: a native WebView). Only the
    shell bridges a site to the engine.
- **Official site**: HyperMD with JS, no hypergraph API, `sites/home`.
- **Official forum**: new, `sites/forum`, features = the forum scenario tests (boards, threads, comments, votes,
  edit/delete, moderation, invites, devices), effort on the UX. Invite-only while testing (Tibo's devices + soak
  members); a fresh public forum at release.
- **Storage**: SwarmFS only (ROADMAP). Its 4 prerequisites come first in SwarmFS: read-only visitors, protected
  pages, app-storage mode, small files inline.

- **Tray** (ROADMAP): the engine keeps running in the tray, on by default, easy to turn off; part of milestone 1
  (without it the forum is offline whenever the window closes).
- **SwarmFS's 4 prerequisites are built, not only specced, before the real shell serves sites**: in milestone 1
  the engine serves a site's files (pages, JS, `site.json`) from its SwarmFS space. Milestone 2's "SwarmFS inside
  the engine" is a SwarmFS API for sites (the file manager), not file serving. *(lead's call, from the ROADMAP's
  "Before milestone 1")*
- **Site API** = hypergraph's public API for the site's own space (spec 015's site handle), async over messages:
  calls return promises, live views stay live across the boundary. The forum scenario tests stay against
  hypergraph directly; the official forum gets its own tests through the site API. *(lead's call)*
- **Identity**: spec 015 gives a site its own derived key by default, but per-site keys aren't built; until they
  are, a dynamic site asks once ("let this site use your identity?", remembered per site) and then acts as the
  main identity. Per-site keys: their own spec. *(lead's call)*
- **Publishing**: the engine's windowless mode has a `publish <folder>` command that writes a site folder into its
  space; the official site's and forum's keys live on Tibo's machine (his devices via device pairing). Visitors get
  updates as the space syncs; hypergraph's type-compatibility check refuses breaking type changes. *(lead's call)*

- **A site is one space, one key** (Tibo): the forum's pages and its posts in the same space; pages writable by the
  owner and admins only, posts by members (SwarmFS's protected pages).
- **Invites** (Tibo): a code or link pasted into HyperBrowser first; a `hyper://` link registered with Windows and
  Linux later in milestone 1, once the shell is real.
- **Distribution** (Tibo): Pear's P2P distribution, updates arriving by themselves as for Keet (which runs on
  Windows, Linux, macOS, BSD, Android, iOS). The spike confirms how pear-runtime does it.

## Order of work

Three pieces start at once, one worker session each, own worktree, test suites one after another (machine load):

1. **Shell spike** (throwaway, `HyperBrowser` repo). Done when:
   1. it starts on Windows and Linux (macOS: one build try, "not tested");
   2. a site page is sandboxed: a test page shows it cannot reach Node, files, or another site's data;
   3. the page talks to the Bare engine through the message protocol and reads a hypergraph space;
   4. a second machine opens that space from its key alone.
   Its findings (what Pear gives, what we must build for sandboxing and many sites) go back into this file before
   the real shell starts.
2. **HyperMD**: real assertion tests first (today only crash checks), then HyperMD → HTML, then `hypermd build`.
3. **SwarmFS**: a spec (`/speckit-specify`) for its 4 prerequisites.

Then: the real shell and engine (from the spike's lessons), `sites/home`, the forum talk → mockups → `sites/forum`.

## Left to the builder

- Electron view type and how the sandbox is enforced (partitions, custom protocol per site, CSP), as long as the
  spike's test page proves goal 4.
- Message framing and encoding (e.g. bare-rpc, compact-encoding), as long as it is versioned and the same on
  desktop and mobile.
- How the shell renders HyperMD (in the site view or ahead of time), and the HTML/CSS the converter emits.
- Bookmark storage format.
