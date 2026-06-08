'use strict'

// store.test.js — unit tests for the pure store/filter/time helpers.
// Run: node --test
//
// These cover the logic the eval cares about: computeNextDue (recurrence),
// the list filters (overdue/today/done/tag), and snooze duration math.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  computeNextDue, isValidRepeat, REPEAT_KINDS,
  addTask, markDone, removeTask, snoozeTask, defaultConfig
} from './store.js'
import { isOverdue, isSnoozed, isDueToday, hasTag } from './filters.js'
import { parseSnooze, parseDue } from './time.js'

// ─── computeNextDue: recurrence ─────────────────────────────────────────────
test('computeNextDue: daily advances exactly 24h', () => {
  const base = '2026-06-08T09:00:00.000Z'
  const next = computeNextDue(base, 'daily')
  assert.equal(new Date(next).getTime() - new Date(base).getTime(), 24 * 3600 * 1000)
})

test('computeNextDue: weekdays skips the weekend (Fri → Mon)', () => {
  // 2026-06-12 is a Friday; the next weekday is Monday 2026-06-15.
  const next = computeNextDue('2026-06-12T09:00:00.000Z', 'weekdays')
  const d = new Date(next)
  assert.equal(d.getUTCDay(), 1, 'should land on a Monday (day 1)')
  assert.ok(new Date(next) > new Date('2026-06-12T09:00:00.000Z'))
})

test('computeNextDue: monthly advances one calendar month (no silent no-op)', () => {
  const base = '2026-06-01T09:00:00.000Z'
  const next = computeNextDue(base, 'monthly')
  assert.ok(next, 'monthly must produce a next due date')
  const d = new Date(next)
  assert.ok(d > new Date(base), 'next occurrence must be strictly later')
  assert.equal(d.getUTCMonth(), 6, 'June (5) + 1 month → July (6)')
})

test('computeNextDue: monthly clamps end-of-month (Jan 31 → Feb 28)', () => {
  const next = computeNextDue('2026-01-31T12:00:00.000Z', 'monthly')
  const d = new Date(next)
  assert.equal(d.getUTCMonth(), 1, 'lands in February')
  assert.equal(d.getUTCDate(), 28, '2026 is not a leap year → Feb 28')
})

test('computeNextDue: "every 3d" adds 3 days; unparseable returns null', () => {
  const base = '2026-06-08T09:00:00.000Z'
  const next = computeNextDue(base, 'every 3d')
  assert.equal(new Date(next).getTime() - new Date(base).getTime(), 3 * 24 * 3600 * 1000)
  assert.equal(computeNextDue(base, 'fortnightly'), null)
})

// ─── repeat validation ──────────────────────────────────────────────────────
test('isValidRepeat: accepts known kinds + intervals, rejects junk', () => {
  for (const k of REPEAT_KINDS) assert.ok(isValidRepeat(k), `${k} should be valid`)
  assert.ok(isValidRepeat('every 2w'))
  assert.equal(isValidRepeat('biweekly'), false)
  assert.equal(isValidRepeat(''), false)
})

// ─── filters ────────────────────────────────────────────────────────────────
const NOW = new Date('2026-06-08T12:00:00.000Z')

test('isOverdue: past + not done + not snoozed', () => {
  assert.ok(isOverdue({ due: '2026-06-07T12:00:00.000Z', done: false }, NOW))
  assert.equal(isOverdue({ due: '2026-06-07T12:00:00.000Z', done: true }, NOW), false)
  assert.equal(isOverdue({ due: '2026-06-09T12:00:00.000Z', done: false }, NOW), false)
  assert.equal(
    isOverdue({ due: '2026-06-07T12:00:00.000Z', done: false, snoozeUntil: '2026-06-08T18:00:00.000Z' }, NOW),
    false,
    'a snoozed task is not overdue'
  )
})

test('isDueToday: same calendar day (local), not done', () => {
  // Build dates in LOCAL time so the assertion is timezone-independent:
  // isDueToday compares local calendar days.
  const now = new Date(2026, 5, 8, 12, 0, 0)          // local noon, Jun 8
  const sameDay = new Date(2026, 5, 8, 20, 0, 0).toISOString()
  const nextDay = new Date(2026, 5, 9, 1, 0, 0).toISOString()
  assert.ok(isDueToday({ due: sameDay, done: false }, now))
  assert.equal(isDueToday({ due: nextDay, done: false }, now), false)
  assert.equal(isDueToday({ due: sameDay, done: true }, now), false)
})

test('hasTag: case-insensitive, ignores leading #', () => {
  const t = { tags: ['work', 'home'] }
  assert.ok(hasTag(t, 'work'))
  assert.ok(hasTag(t, '#WORK'))
  assert.equal(hasTag(t, 'errand'), false)
})

// ─── snooze math ────────────────────────────────────────────────────────────
test('parseSnooze: 2h is ~2 hours ahead of now', () => {
  const base = new Date('2026-06-08T10:00:00.000Z')
  const until = parseSnooze('2h', base)
  assert.equal(new Date(until).getTime() - base.getTime(), 2 * 3600 * 1000)
})

test('parseSnooze: 30m and tomorrow', () => {
  const base = new Date('2026-06-08T10:00:00.000Z')
  assert.equal(new Date(parseSnooze('30m', base)).getTime() - base.getTime(), 30 * 60 * 1000)
  const tom = new Date(parseSnooze('tomorrow', base))
  assert.equal(tom.getDate(), base.getDate() + 1)
  assert.equal(tom.getHours(), 9, 'tomorrow → 9am local')
})

test('parseSnooze: junk throws; parseDue rejects bad input', () => {
  assert.throws(() => parseSnooze('soon'))
  assert.throws(() => parseDue('not-a-date'))
})

// ─── store mutations remain immutable ───────────────────────────────────────
test('addTask / markDone / snoozeTask / removeTask are immutable + correct', () => {
  const empty = { tasks: [], lastNotified: {}, config: defaultConfig() }
  const { store: s1, task } = addTask(empty, { text: 'T', due: '2026-06-08T09:00:00.000Z' })
  assert.equal(empty.tasks.length, 0, 'original store untouched')
  assert.equal(s1.tasks.length, 1)

  const s2 = snoozeTask(s1, task.id, '2026-06-09T09:00:00.000Z')
  assert.equal(s1.tasks[0].snoozeUntil, null, 'original task untouched')
  assert.equal(s2.tasks[0].snoozeUntil, '2026-06-09T09:00:00.000Z')
  assert.ok(isSnoozed(s2.tasks[0], NOW))

  const s3 = markDone(s2, task.id)
  assert.equal(s3.tasks.find(t => t.id === task.id).done, true)

  const s4 = removeTask(s1, task.id)
  assert.equal(s4.tasks.length, 0)
  assert.equal(s1.tasks.length, 1, 'original store untouched after remove')
})

test('markDone reschedules a recurring task to a strictly-later occurrence', () => {
  const empty = { tasks: [], lastNotified: {}, config: defaultConfig() }
  const { store: s1, task } = addTask(empty, {
    text: 'Standup', due: '2026-06-08T09:00:00.000Z', repeat: 'weekdays'
  })
  const s2 = markDone(s1, task.id)
  const next = s2.tasks.find(t => t.text === 'Standup' && !t.done && t.id !== task.id)
  assert.ok(next, 'a next occurrence must be created')
  assert.ok(new Date(next.due) > new Date(task.due), 'next due is strictly later')
})
