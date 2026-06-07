#!/usr/bin/env node
'use strict'

// daemon.js — persistent nagging daemon for tenacious-todo
// Usage:
//   node daemon.js          — run forever, checking every 60s
//   node daemon.js --once   — evaluate and fire all due reminders once, then exit

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readStore, writeStore, updateLastNotified } from './store.js'

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
 * @param {number} overdueMs - milliseconds past due (>0 means overdue)
 * @returns {number} interval in ms
 */
function nagInterval(overdueMs) {
  for (const tier of ESCALATION) {
    if (overdueMs >= tier.overdueMs) return tier.intervalMs
  }
  return ESCALATION[ESCALATION.length - 1].intervalMs
}

/**
 * Escape a string for safe embedding inside an AppleScript string literal.
 * Replaces backslashes and double-quotes.
 * @param {string} str
 * @returns {string}
 */
function escapeForAppleScript(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Fire a macOS notification via osascript.
 * @param {string} title
 * @param {string} message
 */
async function fireNotification(title, message) {
  const safeTitle = escapeForAppleScript(title)
  const safeMessage = escapeForAppleScript(message)
  const script = `display notification "${safeMessage}" with title "${safeTitle}" sound name "Glass"`
  await execFileAsync('osascript', ['-e', script])
}

/**
 * Evaluate all tasks and fire notifications for overdue ones that are ready to nag.
 * Returns the updated store (immutably).
 */
async function evaluateAndNotify() {
  let store = readStore()
  const now = Date.now()
  const errors = []

  for (const task of store.tasks) {
    if (task.done || !task.due) continue

    const dueTime = new Date(task.due).getTime()
    if (isNaN(dueTime)) continue

    const overdueMs = now - dueTime
    if (overdueMs <= 0) continue  // Not yet due

    const interval = nagInterval(overdueMs)
    const lastNag = store.lastNotified[task.id] || 0
    const timeSinceLast = now - lastNag

    if (timeSinceLast < interval) continue  // Too soon to nag again

    // Build notification message
    const overdueHours = Math.floor(overdueMs / (60 * 60 * 1000))
    const overdueMinutes = Math.floor((overdueMs % (60 * 60 * 1000)) / (60 * 1000))
    let overdueStr
    if (overdueHours > 0) {
      overdueStr = `${overdueHours}h ${overdueMinutes}m overdue`
    } else {
      overdueStr = `${overdueMinutes}m overdue`
    }

    const priorityPrefix = task.priority === 'high' ? '🔴 ' : task.priority === 'low' ? '🟢 ' : '🟡 '
    const message = `${priorityPrefix}${task.text} (${overdueStr})`

    try {
      await fireNotification('Tenacious Todo', message)
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
  console.log(`[${new Date().toISOString()}] tenacious-todo daemon started (poll every ${DAEMON_POLL_MS / 1000}s)`)
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
  process.on('SIGINT', () => {
    clearInterval(timer)
    console.log(`\n[${new Date().toISOString()}] Daemon stopped.`)
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    clearInterval(timer)
    console.log(`\n[${new Date().toISOString()}] Daemon stopped.`)
    process.exit(0)
  })
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
