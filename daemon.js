#!/usr/bin/env node
'use strict'

// daemon.js — persistent nagging daemon for tenacious-todo (v2)
// Usage:
//   node daemon.js          — run forever, checking every 60s
//   node daemon.js --once   — evaluate and fire all due reminders once, then exit

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readStore, writeStore, updateLastNotified, updateConfig } from './store.js'

const execFileAsync = promisify(execFile)

// Escalation thresholds: how overdue (ms) → minimum interval between nags (ms)
const ESCALATION = [
  { overdueMs: 4 * 60 * 60 * 1000,  intervalMs: 5  * 60 * 1000 },  // >4h overdue  → every 5min
  { overdueMs: 1 * 60 * 60 * 1000,  intervalMs: 15 * 60 * 1000 },  // 1-4h overdue → every 15min
  { overdueMs: 0,                    intervalMs: 30 * 60 * 1000 },  // <1h overdue  → every 30min
]

const DAEMON_POLL_MS = 60 * 1000  // poll every 60s

/**
 * Determine the nag interval for a task based on how overdue it is.
 * @param {number} overdueMs
 * @returns {number}
 */
function nagInterval(overdueMs) {
  for (const tier of ESCALATION) {
    if (overdueMs >= tier.overdueMs) return tier.intervalMs
  }
  return ESCALATION[ESCALATION.length - 1].intervalMs
}

/**
 * Escape a string for safe embedding inside an AppleScript string literal.
 */
function escapeForAppleScript(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Fire a macOS notification via osascript.
 * @param {string} title
 * @param {string} subtitle
 * @param {string} message
 * @param {string} sound
 */
async function fireNotification(title, subtitle, message, sound = 'Glass') {
  const safeTitle    = escapeForAppleScript(title)
  const safeSubtitle = escapeForAppleScript(subtitle)
  const safeMessage  = escapeForAppleScript(message)
  const script = [
    `display notification "${safeMessage}"`,
    `with title "${safeTitle}"`,
    subtitle ? `subtitle "${safeSubtitle}"` : '',
    `sound name "${sound}"`
  ].filter(Boolean).join(' ')
  await execFileAsync('osascript', ['-e', script])
}

/**
 * Check whether the current time falls inside quiet hours.
 * quietHoursStart and quietHoursEnd are 0-23 hour integers.
 * If start > end (e.g. 23-8), the quiet window crosses midnight.
 */
function isQuietHours(config) {
  const now  = new Date()
  const hour = now.getHours()
  const { quietHoursStart: start, quietHoursEnd: end } = config

  if (start === end) return false
  if (start > end) {
    // Crosses midnight: quiet if hour >= start OR hour < end
    return hour >= start || hour < end
  }
  // Same day window (e.g. 13–15)
  return hour >= start && hour < end
}

/**
 * Check whether it is time to send the morning summary.
 * Returns true once per calendar day, at or after morningHour.
 */
function shouldSendMorningSummary(config) {
  const now  = new Date()
  const hour = now.getHours()
  if (hour < (config.morningHour ?? 8)) return false

  const todayKey = now.toISOString().slice(0, 10)
  if (config.lastMorningSummary === todayKey) return false

  return true
}

/**
 * Build and fire the morning summary notification.
 */
async function sendMorningSummary(store) {
  const now  = new Date()
  const tasks = store.tasks.filter(t => !t.done)

  const overdue  = tasks.filter(t => t.due && new Date(t.due) < now && !isSnoozed(t, now))
  const dueToday = tasks.filter(t => {
    if (!t.due) return false
    const d = new Date(t.due)
    return d.getFullYear() === now.getFullYear()
      && d.getMonth()     === now.getMonth()
      && d.getDate()      === now.getDate()
      && d >= now
  })

  const parts = []
  if (overdue.length)  parts.push(`${overdue.length} overdue`)
  if (dueToday.length) parts.push(`${dueToday.length} due today`)
  if (!parts.length)   parts.push('all clear — great work!')

  const message = parts.join(', ')
  const title = 'Good morning ☀️  Tenacious Todo'
  const subtitle = `${tasks.length} task${tasks.length === 1 ? '' : 's'} pending`

  try {
    await fireNotification(title, subtitle, message, 'Blow')
    console.log(`[${new Date().toISOString()}] Morning summary sent: ${message}`)
  } catch (err) {
    console.error(`[WARN] Morning summary failed: ${err.message}`)
  }

  const todayKey  = now.toISOString().slice(0, 10)
  return updateConfig(store, { lastMorningSummary: todayKey })
}

function isSnoozed(task, now) {
  if (!task.snoozeUntil) return false
  return new Date(task.snoozeUntil) > now
}

/**
 * Evaluate all tasks and fire notifications for overdue ones that are ready to nag.
 * Returns the updated store (immutably).
 */
async function evaluateAndNotify(forcedStore) {
  let store = forcedStore || readStore()
  const now   = Date.now()
  const nowDate = new Date(now)
  const config  = store.config
  const errors  = []

  // Morning summary
  if (shouldSendMorningSummary(config)) {
    store = await sendMorningSummary(store)
  }

  // Respect quiet hours
  if (isQuietHours(config)) {
    console.log(`[${new Date().toISOString()}] Quiet hours active (${config.quietHoursStart}:00–${config.quietHoursEnd}:00), skipping nags.`)
    writeStore(store)
    return store
  }

  for (const task of store.tasks) {
    if (task.done || !task.due) continue

    const dueTime = new Date(task.due).getTime()
    if (isNaN(dueTime)) continue

    // Skip snoozed tasks
    if (isSnoozed(task, nowDate)) continue

    const overdueMs = now - dueTime
    if (overdueMs <= 0) continue  // Not yet due

    const interval     = nagInterval(overdueMs)
    const lastNag      = store.lastNotified[task.id] || 0
    const timeSinceLast = now - lastNag

    if (timeSinceLast < interval) continue  // Too soon to nag again

    // Build notification content
    const overdueHours   = Math.floor(overdueMs / (60 * 60 * 1000))
    const overdueMinutes = Math.floor((overdueMs % (60 * 60 * 1000)) / (60 * 1000))
    let overdueStr
    if (overdueHours > 0) {
      overdueStr = `${overdueHours}h ${overdueMinutes}m overdue`
    } else {
      overdueStr = `${overdueMinutes}m overdue`
    }

    const priorityEmoji  = task.priority === 'high' ? '🔴' : task.priority === 'low' ? '🟢' : '🟡'
    const tagStr         = task.tags && task.tags.length ? ` [${task.tags.join(', ')}]` : ''
    const repeatStr      = task.repeat ? ` ↻ ${task.repeat}` : ''
    const subtitle       = `${overdueStr}${tagStr}${repeatStr}`
    const message        = `${priorityEmoji} ${task.text}`
    const sound          = task.priority === 'high' ? 'Sosumi' : 'Glass'

    try {
      await fireNotification('Tenacious Todo ⏰', subtitle, message, sound)
      console.log(`[${new Date().toISOString()}] Notified: [${task.id}] "${task.text}" (${overdueStr})`)
      store = updateLastNotified(store, task.id, now)
    } catch (err) {
      errors.push(`Failed to notify task [${task.id}]: ${err.message}`)
    }
  }

  if (errors.length) {
    for (const e of errors) console.error(`[WARN] ${e}`)
  }

  writeStore(store)
  return store
}

async function runOnce() {
  console.log(`[${new Date().toISOString()}] tenacious-todo daemon --once: evaluating tasks...`)
  try {
    await evaluateAndNotify()
    console.log(`[${new Date().toISOString()}] Done.`)
  } catch (err) {
    console.error(`[ERROR] ${err.message}`)
    process.exit(1)
  }
}

async function runForever() {
  console.log(`[${new Date().toISOString()}] tenacious-todo daemon v2 started (poll every ${DAEMON_POLL_MS / 1000}s)`)
  console.log('Press Ctrl+C to stop.\n')

  // Run immediately on startup, then poll
  try {
    await evaluateAndNotify()
  } catch (err) {
    console.error(`[ERROR] ${err.message}`)
  }

  const timer = setInterval(async () => {
    try {
      await evaluateAndNotify()
    } catch (err) {
      console.error(`[ERROR] ${err.message}`)
    }
  }, DAEMON_POLL_MS)

  // Graceful shutdown
  const shutdown = () => {
    clearInterval(timer)
    console.log(`\n[${new Date().toISOString()}] Daemon stopped.`)
    process.exit(0)
  }
  process.on('SIGINT',  shutdown)
  process.on('SIGTERM', shutdown)
}

async function main() {
  const once = process.argv.includes('--once')
  if (once) {
    await runOnce()
  } else {
    await runForever()
  }
}

main()
