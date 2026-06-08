'use strict'

// filters.js — pure task predicates shared by the CLI, daemon, and tests.
// Each predicate is side-effect free; `now` is injectable for deterministic tests.

/**
 * Is this task overdue right now? A task is overdue when it has a past due date,
 * is not done, and is not currently snoozed.
 * @param {object} task
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isOverdue(task, now = new Date()) {
  if (!task || !task.due || task.done) return false
  if (isSnoozed(task, now)) return false
  const due = new Date(task.due)
  if (isNaN(due.getTime())) return false
  return due < now
}

/**
 * Is this task currently snoozed (snoozeUntil in the future)?
 * @param {object} task
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isSnoozed(task, now = new Date()) {
  if (!task || !task.snoozeUntil) return false
  const until = new Date(task.snoozeUntil)
  if (isNaN(until.getTime())) return false
  return until > now
}

/**
 * Is this task due on the same calendar day as `now` (local time) and not done?
 * @param {object} task
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isDueToday(task, now = new Date()) {
  if (!task || !task.due || task.done) return false
  const d = new Date(task.due)
  if (isNaN(d.getTime())) return false
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
}

/**
 * Does this task carry the given tag (case-insensitive, leading '#' ignored)?
 * @param {object} task
 * @param {string} tag
 * @returns {boolean}
 */
export function hasTag(task, tag) {
  if (!task || !Array.isArray(task.tags) || !tag) return false
  const norm = String(tag).toLowerCase().replace(/^#/, '')
  return task.tags.includes(norm)
}
