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

## Visual identity and the official forum (forum talk with Tibo, 2026-11-07)

The look of everything the project makes (the shell, built-in pages, the official site, the forum); other
people's sites look as they like.

- **Style**: simple, a bit minimalist, black and white, the Macintosh System 1 spirit (window frames, striped
  title bars, dithered grays, 1-bit pixel icons), with box-drawing characters where they read best (the reply
  tree, separators, quotes). Not today's over-designed web; usability of the old forums, modern care.
  System 1 gives the **look**, not the interface: no copied menu bar (File, Edit, View...); HyperBrowser's
  own controls are designed for what it does (Tibo, after the first mockup).
- **Colour**: black and white plus **one accent** (links, unread, your own posts, your votes). Dark mode = the
  same design inverted.
- **Fonts**: TTF fonts in the old IBM / Cozette spirit, never a game "pixel" font: **Cozette** for the interface,
  titles and the tree, **IBM Plex Mono** for post text: all monospace.
- **Forum front page**: boards on the left, the chosen board's threads on the right (a System 1 window with
  panes); on a phone, boards then threads.
- **Sorting**: the reader chooses; default **latest activity first** (a reply brings a thread back up); also
  newest, top (votes), lively (most replies and votes lately, computed on the device, never by a server).
- **Replies**: a tree, with very small indentation (one box-drawing step, ~2 characters, per level); folding.
- **Members**: a tiny 16×16 1-bit icon, drawn by the member or made from their key, next to the name.
- **Posts**: a HyperMD subset (bold, italic, links, quotes, code, images), no scripts; `@name` mentions store
  the member's key, show the current name (names aren't unique), and go into a **Mentions** list you open
  yourself: no badge, no counter; the accent marks the unread ones.
- **Votes**: ▲▼ with the score, small, the accent once you voted.
- **Unread**: threads and posts you haven't read are marked with the accent; read state stays on your devices.
- **The shell** (interface talk, 2026-11-07): a light window-manager feel, because HyperBrowser is a superapp.
  - The shell draws the frame; sites draw only their content (a site can't fake the shell).
  - Top bar: **"HyperBrowser ▾"** menu (installed apps, settings, your identity), then the **tabs, drawn as a
    taskbar** of open sites and apps. Each fills the space: no dragging, no resizing; others stay open in the
    background. On a phone the taskbar is at the bottom. Overlapping windows: maybe later, as a first plugin,
    if HyperBrowser gets plugins like Firefox and Chrome.
  - Under it, the current tab's **toolbar**: back, forward, reload, the address, ☆, and the site's state on the
    right (complete or loading, peers, what you hold).
  - The address shows the site's name and a short key (`HyperBrowser Forum · 6x99a3…cjy`); the full key when
    editing; a full key pasted by hand opens the site; hyperDNS names later in the same field.
  - **Home = a desktop**: a grid of 1-bit icons (each site's own, from `site.json`) you arrange; folders later;
    Mentions is an icon there.
  - **One kind of thing, a site**: "install" = an icon on the desktop, kept whole on disk (never evicted) and
    seeded; a bookmark = a lighter icon, cached and evicted as usual. Downloadable apps that can't run as a site
    (maybe SwarmFS's file manager): a second kind later, only if needed.
- **Mockups**: first pass at https://claude.ai/artifact/Vo3NWXhGwF6SXY74qKZRe5 (front page, a thread; accent and
  dark mode as tweaks; Cozette Vector 1.30.0, MIT, for the interface, Plex Mono for post text). Tibo may bring his own
  (e.g. Figma's AI) for the second pass.

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
