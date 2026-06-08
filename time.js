'use strict'

// time.js — pure date/duration parsing helpers shared by the CLI and tests.

/**
 * Parse a due-date string into an ISO 8601 string.
 * Accepts "YYYY-MM-DD HH:MM" or any Date-parseable value.
 * @param {string} raw
 * @returns {string} ISO string
 * @throws if the value cannot be parsed
 */
export function parseDue(raw) {
  const d = new Date(raw)
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: "${raw}". Use format: "YYYY-MM-DD HH:MM" or ISO 8601.`)
  }
  return d.toISOString()
}

/**
 * Parse a snooze duration/target into an ISO 8601 string for `snoozeUntil`.
 * Supports: "30m", "2h", "tomorrow" (→ 9am next day), or a full date.
 * `now` is injectable for deterministic tests.
 * @param {string} raw
 * @param {Date} [now]
 * @returns {string} ISO string
 * @throws if the value cannot be parsed
 */
export function parseSnooze(raw, now = new Date()) {
  if (typeof raw !== 'string') {
    throw new Error(`Cannot parse snooze: "${raw}". Use: 30m, 2h, tomorrow, or a date.`)
  }
  const lower = raw.toLowerCase().trim()

  if (lower === 'tomorrow') {
    const t = new Date(now)
    t.setDate(t.getDate() + 1)
    t.setHours(9, 0, 0, 0)
    return t.toISOString()
  }

  const minMatch = lower.match(/^(\d+)m$/)
  if (minMatch) {
    return new Date(now.getTime() + parseInt(minMatch[1], 10) * 60 * 1000).toISOString()
  }

  const hourMatch = lower.match(/^(\d+)h$/)
  if (hourMatch) {
    return new Date(now.getTime() + parseInt(hourMatch[1], 10) * 60 * 60 * 1000).toISOString()
  }

  // Fall back to a full date parse.
  const d = new Date(raw)
  if (!isNaN(d.getTime())) return d.toISOString()

  throw new Error(`Cannot parse snooze: "${raw}". Use: 30m, 2h, tomorrow, or a date.`)
}
