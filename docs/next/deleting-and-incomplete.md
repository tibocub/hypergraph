# "Deleted" and "incomplete", plainly

`require('hypergraph/next')` (spec 011). Two words your app will show people, and what they really mean
on a network with no server. The worked example is the forum in `test/next/forum/forum.js`; the API is in
[api.md](api.md), the reasons in [concepts.md](concepts.md).

## Deleted

```js
await forum.del(post.id)          // your own post: deleted
await forum.del(theirPost.id)     // a moderator: taken down (a decision, for good)
await forum.moderateAction('hide', post, { reason: 'off topic' })   // hidden: can be revealed again
```

There is no server holding "the" copy of a post. Every member holds its own copy, so deleting means
asking every copy to go:

- **Deleted by its author.** The author's app writes a small "deleted" record. Every member that gets it
  stops showing the post and wipes its bytes from its disk. A member that was offline does the same when it comes back. A newcomer never sees it.
- **Taken down by a moderator.** The same, decided in the space's decision log: it can't be undone, and
  the author can't bring it back by editing.
- **Hidden by a moderator.** Not deleted: left out of lists, still found by `get()` (marked `hidden`), and
  a moderator can reveal it again.
- **Edited.** The old version is replaced everywhere; what members show is always the latest one.

`get(id)` says which: `{ record: null, deleted: { by: 'author', stamp, device } }` (deleted by its author),
`{ deleted: { by: 'space' } }` (taken down), or `deleted: null` with `record: null`: not here (yet), or
never heard of. So an app never takes "not received yet" for "deleted". `change` lists a deleted record with
the same `deleted`.

What deleting **can't** promise, and your app should say where people delete things:

- Someone who already read the post may remember it, or have copied it (a screenshot).
- A **modified app** can ignore the "deleted" record and keep its copy. So can a device that was offline
  and never came back. Every honest member wipes its copy; nobody can force the others. Email works the
  same way.

A good wording for a delete button: *"Delete for everyone. People who already saw it may keep a copy."*

Only a record's author deletes it (and moderators, by taking it down). On a shared page (a wiki), an
editor who doesn't like the page edits it; the next edit can restore it.

## Incomplete

```js
const { items, complete } = await forum.query('post').latest(20)
```

Every read answers at once from what this device holds, with `complete` saying whether anything it
knows of is still on its way. A read given `{ timeout }` waits up to that for it (a one-shot script);
an app's screens don't wait: they show the answer and update when told.

`complete: false` means **"there is more I know of but haven't received yet"**: a member's records still
downloading, a member whose list of logs this device hasn't looked at yet, a post too old for what this
device keeps (its content is fetched from whoever holds it, and that member is offline). It never means
"this answer is wrong": what is shown is real; something may be missing.

What to do in the UI:

- **Show the answer.** Add a quiet hint ("still syncing…") rather than a spinner that blocks.
- **Update it when told**: a live query re-runs when records arrive and when the answer may have become
  complete: `forum.query('post').live(({ items, complete }) => render(items, complete))`. Every other read
  has its event ([api.md](api.md#knowing-when-to-read-again)).
- **Don't wait forever.** If the only members holding something are offline, the answer stays incomplete
  until one comes back; `space.status().complete` and its `status` event say when everything is here.

`complete: true` means everything this device knows of, from the oldest item of the answer on, is here —
for a newcomer to a big space, the same page a member holding everything shows. It can't promise more
than what anyone has told this device: a post written by someone who is offline and never connected to
anyone can't be waited for.

A space where you are the only member, on your only device, is always complete. A device's own records are
always here.

### Private spaces: "not for me"

In a private space this device may not read (it was removed, or it only passes data on), reads answer at
with `{ items: [], complete: false, access: 'none' }`. `space.status().access` says `'full'`, `'waiting'` (a
new member whose key hasn't arrived yet: reads are incomplete until it does, and `status` says when) or
`'none'`.
