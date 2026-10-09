# The inspector

A web page that shows what a running hypergraph (the new core, `require('hypergraph/next')`) holds:
this person and their devices, the spaces, and for each space its members and roles, its decisions,
the device logs and the records. For app developers when something looks wrong, and for watching the
core work. Later it becomes HyperBrowser's developer-tools panel.

**Read-only.** The server answers `GET` and nothing else (`405` for the rest), and every read it makes
has `timeout: 0`: it never waits, never fetches, never writes. A record whose content was dropped here
(budgets) is left out, and the page says "not complete".

**Node only, for now.** It uses Node's `http` module. The core itself runs on Node and Bare.

## Embed it in your app

A hypergraph's folder can be opened by one program at a time, so the inspector runs inside your app,
next to the instance it shows:

```js
const { Hypergraph } = require('hypergraph/next')
const { serveInspector } = require('hypergraph/tools/inspector')

const hg = await Hypergraph.open('./data', { types })
const { url, close } = await serveInspector(hg, { port: 4400 })   // port 0: any free port
console.log('Inspector:', url)                                    // http://127.0.0.1:4400/
// ...
await close()
```

It listens on `127.0.0.1` only (`{ host }` changes that: anyone who can reach it reads everything,
the personal space included). The page updates by itself, from the app's events: records changed, a
space's status, logs arriving or growing (`logs`), peers connecting or leaving (`peers`). It never polls.

## The demo

```bash
node tools/inspector/demo.js
```

Three people (alice, bob, carol) on a local DHT, each with an inspector at
`http://127.0.0.1:4401/`, `4402`, `4403` (a fourth, `4404`, for alice's phone when it is added). It
plays the forum scenario slowly (create, invite, post, comment, vote, edit, tag, a moderator, hide,
flag, a new device) and prints what to look for after each step. Open the addresses side by side.
Ctrl-C stops it and removes its temp folders. Options: `--port 5000` (first port), `--pause 2000`
(ms between steps), `--once` (stop after the last step).

## What it shows

| View | From |
|---|---|
| This app: person, devices, disk used and budget, declared types | `hg.identity`, `hg.device`, `hg.devices()`, `hg.storage()`, `hg.types()` |
| Spaces: name, complete, peers, members, rows, warnings | `hg.spaces()`, `hg.personal`, `space.inspect()` |
| Overview: policy, held, stored, share, budget, warnings, who is connected | `space.inspect()`, `space.status()`, `space.peers()` |
| Members & roles: roles, banned and removed people, their devices, who decides | `space.members()`, `space.roles()`, `inspect().decisions.writers` |
| Decisions: who decided what, when, why, and whether it counted; settled, settlers | `space.decisions()`, `inspect().decisions` |
| Device logs: known, held, indexed, dropped, cut, refused, waiting | `inspect().logs` |
| Records by type, newest first, 25 a page (or every row: hidden, superseded, dropped); one record with what points at it, its relations, tags and history (versions, deletes) | `space.query(type).latest()`, `inspect({ records })`, `get()`, `linked()`, `edges()`, `space.tags()`, `inspect({ record })` |

JSON views (the page uses them; handy with `curl`): `api/instance`, `api/spaces`, `api/space?key=`,
`api/records?key=&type=&after=&limit=`, `api/rows?key=&type=&after=&limit=` (every row),
`api/decisions?key=&after=&limit=`, `api/record?key=&id=`, and `api/events` (server-sent events).
`key=personal` is the personal space.

## Rules for changing it

Built only on the public API and `space.inspect()`: never on `lib/` internals. If it needs something
they don't give, ask the core for it. Plain HTML, CSS and JS: no build step, no framework, no CDN.
`test/next/tools/inspector.js` checks every view; keep it passing (it runs in `npm run test:next`).
