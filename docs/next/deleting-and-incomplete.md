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

Every read answers from what this device holds, waits a little (5 s by default, `{ timeout }` to change
it) for what it knows exists but hasn't received yet, and then answers anyway, with `complete` saying
whether anything is missing.

`complete: false` means **"there is more I know of but haven't received yet"**: a member's records still
downloading, a member whose list of logs this device hasn't looked at yet, a post too old for what this
device keeps (its content is fetched from whoever holds it, and that member is offline). It never means
"this answer is wrong": what is shown is real; something may be missing.

What to do in the UI:

- **Show the answer.** Add a quiet hint ("still syncing…") rather than a spinner that blocks.
- **Read again later**, or use a live query, which re-runs when records arrive:
  `forum.query('post').live(({ items, complete }) => render(items, complete))`.
- **Don't wait forever.** Nothing in hypergraph waits longer than its bound; if the only members holding
  something are offline, the answer stays incomplete until one comes back.

`complete: true` means everything this device knows of, from the oldest item of the answer on, is here —
for a newcomer to a big space, the same page a member holding everything shows. It can't promise more
than what anyone has told this device: a post written by someone who is offline and never connected to
anyone can't be waited for.

A space where you are the only member, on your only device, is always complete. A device's own records are
always here.

### Private spaces: "not for me"

In a private space this device may not read (it was removed, or it only passes data on), reads answer at
once with `{ items: [], complete: false, access: 'none' }` instead of waiting. `space.status().access` says
`'full'`, `'waiting'` (a new member whose key hasn't arrived yet: reads wait as usual) or `'none'`.
