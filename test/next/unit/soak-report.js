// The soak run's report (soak/report.js) on hand-made delivery logs: lost
// records, edits and deletes that didn't arrive, delays, a missing snapshot.

const test = require('brittle')
const { analyze } = require('../../../soak/report.js')

const held = (...records) => ({ ev: 'held', at: 9000, records })

test('soak report: lost, stale, delays', (t) => {
  const logs = {
    m0: [
      { ev: 'put', id: 'p1', type: 'post', at: 1000, v: 'hi' },
      { ev: 'put', id: 'p2', type: 'post', at: 2000, v: 'second' },
      { ev: 'edit', id: 'p1', at: 3000, v: 'hi, edited' },
      { ev: 'put', id: 'p3', type: 'post', at: 4000, v: 'gone' },
      { ev: 'delete', id: 'p3', at: 4500 },
      { ev: 'offline', mode: 'close', ms: 1000 },
      { ev: 'seen', id: 'c1', at: 5500 },
      held({ id: 'p1', v: 'hi, edited' }, { id: 'p2', v: 'second' }, { id: 'c1', v: 'yes' })
    ],
    m1: [
      { ev: 'seen', id: 'p1', at: 1100 },
      { ev: 'seen', id: 'p1', at: 3200 }, // the edit: only the first sighting counts
      { ev: 'seen', id: 'p3', at: 4300 },
      { ev: 'put', id: 'c1', type: 'comment', at: 5000, v: 'yes' },
      { ev: 'warning', code: 'SINGLE_SETTLER' },
      { ev: 'warning', code: 'SINGLE_SETTLER' },
      // never got p2; holds p1 unedited; p3's delete didn't arrive
      held({ id: 'p1', v: 'hi' }, { id: 'p3', v: 'gone' }, { id: 'c1', v: 'yes' })
    ]
  }
  const { members, total, ok } = analyze(logs)
  t.is(members.m0.written, 3)
  t.alike(members.m0.lost, [])
  t.alike(members.m0.stale, [])
  t.alike(members.m0.delay, { n: 1, p50: 500, p95: 500, max: 500 })
  t.is(members.m0.offline, 1)
  t.alike(members.m1.lost, ['p2'])
  t.alike(members.m1.stale.sort(), ['p1', 'p3'])
  t.alike(members.m1.delay, { n: 2, p50: 100, p95: 300, max: 300 })
  t.alike(members.m1.warnings, ['SINGLE_SETTLER'])
  t.is(total.written, 4)
  t.is(total.lost, 1)
  t.is(total.stale, 2)
  t.alike(total.delay, { n: 3, p50: 300, p95: 500, max: 500 })
  t.absent(ok)
})

test('soak report: a member without a final snapshot fails the run', (t) => {
  const { total, ok } = analyze({
    m0: [{ ev: 'put', id: 'p1', type: 'post', at: 1, v: 'x' }, held({ id: 'p1', v: 'x' })],
    m1: [{ ev: 'seen', id: 'p1', at: 2 }]
  })
  t.alike(total.missingFinal, ['m1'])
  t.is(total.lost, 0)
  t.absent(ok)
})

test('soak report: everything delivered is ok', (t) => {
  const { ok, total } = analyze({
    m0: [{ ev: 'put', id: 'p1', type: 'post', at: 1, v: 'x' }, held({ id: 'p1', v: 'x' })],
    m1: [{ ev: 'seen', id: 'p1', at: 2 }, held({ id: 'p1', v: 'x' })]
  })
  t.ok(ok)
  t.alike(total.delay, { n: 1, p50: 1, p95: 1, max: 1 })
})
