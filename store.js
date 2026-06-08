'use strict'

// store.js — immutable JSON task store (~/.tenacious-todo/tasks.json)
// Schema v2: adds repeat, tags, note, snoozeUntil, subtasks

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve the data directory for the task store.
 *
 * Isolation contract: when the env var TENACIOUS_HOME is set (and non-empty),
 * it IS the data dir. This lets tests and the eval harness point at a fresh
 * temp dir so the real ~/.tenacious-todo is never touched. Falls back to
 * ~/.tenacious-todo otherwise.
 *
 * Resolved per-call (not cached) so a single process can switch homes between
 * operations — important for tests that spawn within one runtime.
 */
export function dataDir() {
  const override = process.env.TENACIOUS_HOME
  if (override && override.trim()) return override
  return join(homedir(), '.tenacious-todo')
}

function tasksFile() {
  return join(dataDir(), 'tasks.json')
}

function ensureDir() {
  const dir = dataDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/** @returns {{ tasks: Task[], lastNotified: Record<string,number>, config: Config }} */
export function readStore() {
  ensureDir()
  const file = tasksFile()
  if (!existsSync(file)) {
    return { tasks: [], lastNotified: {}, config: defaultConfig() }
  }
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      lastNotified: parsed.lastNotified && typeof parsed.lastNotified === 'object'
        ? parsed.lastNotified
        : {},
      config: parsed.config && typeof parsed.config === 'object'
        ? { ...defaultConfig(), ...parsed.config }
        : defaultConfig()
    }
  } catch (err) {
    throw new Error(`Failed to read task store: ${err.message}`)
  }
}

/** @param {{ tasks: Task[], lastNotified: Record<string,number>, config: Config }} store */
export function writeStore(store) {
  ensureDir()
  try {
    writeFileSync(tasksFile(), JSON.stringify(store, null, 2), 'utf8')
  } catch (err) {
    throw new Error(`Failed to write task store: ${err.message}`)
  }
}

/** Default configuration values */
export function defaultConfig() {
  return {
    quietHoursStart: 23,  // 11 PM
    quietHoursEnd: 8,     // 8 AM
    morningHour: 8,       // 8 AM morning summary
    lastMorningSummary: null
  }
}

/**
 * Pure helper: add a new task and return a NEW store object.
 * @param {{ tasks: Task[], lastNotified: Record<string,number> }} store
 * @param {{ text: string, due?: string, priority?: string, repeat?: string, tags?: string[], note?: string }} opts
 * @returns {{ store: object, task: Task }}
 */
export function addTask(store, { text, due, priority, repeat, tags, note }) {
  const id = generateId(store.tasks)
  const task = {
    id,
    text,
    due: due || null,
    priority: priority || 'med',
    done: false,
    createdAt: new Date().toISOString(),
    repeat: repeat || null,
    tags: Array.isArray(tags) ? tags : [],
    note: note || null,
    snoozeUntil: null,
    doneAt: null
  }
  return {
    store: { ...store, tasks: [...store.tasks, task] },
    task
  }
}

/**
 * Pure helper: mark task done and return a NEW store.
 * If the task has a repeat schedule, also creates the next occurrence.
 */
export function markDone(store, id) {
  const idx = store.tasks.findIndex(t => t.id === id)
  if (idx === -1) throw new Error(`Task with id "${id}" not found.`)
  const task = store.tasks[idx]
  const updatedTask = { ...task, done: true, doneAt: new Date().toISOString() }

  const tasks = [
    ...store.tasks.slice(0, idx),
    updatedTask,
    ...store.tasks.slice(idx + 1)
  ]

  // Remove lastNotified entry for this task
  const { [id]: _removed, ...remainingNotified } = store.lastNotified
  let newStore = { ...store, tasks, lastNotified: remainingNotified }

  // Schedule next occurrence for recurring tasks
  if (task.repeat && task.due) {
    const nextDue = computeNextDue(task.due, task.repeat)
    if (nextDue) {
      const { store: withNext } = addTask(newStore, {
        text: task.text,
        due: nextDue,
        priority: task.priority,
        repeat: task.repeat,
        tags: task.tags,
        note: task.note
      })
      newStore = withNext
    }
  }

  return newStore
}

/**
 * Pure helper: remove a task and return a NEW store.
 */
export function removeTask(store, id) {
  const idx = store.tasks.findIndex(t => t.id === id)
  if (idx === -1) throw new Error(`Task with id "${id}" not found.`)
  const tasks = [
    ...store.tasks.slice(0, idx),
    ...store.tasks.slice(idx + 1)
  ]
  const { [id]: _removed, ...remainingNotified } = store.lastNotified
  return { ...store, tasks, lastNotified: remainingNotified }
}

/**
 * Pure helper: update lastNotified for a task id.
 */
export function updateLastNotified(store, id, timestamp) {
  return {
    ...store,
    lastNotified: { ...store.lastNotified, [id]: timestamp }
  }
}

/**
 * Pure helper: snooze a task by updating its snoozeUntil field.
 * @param {object} store
 * @param {string} id
 * @param {string} isoDateTime
 */
export function snoozeTask(store, id, isoDateTime) {
  const idx = store.tasks.findIndex(t => t.id === id)
  if (idx === -1) throw new Error(`Task with id "${id}" not found.`)
  const updatedTask = { ...store.tasks[idx], snoozeUntil: isoDateTime }
  const tasks = [
    ...store.tasks.slice(0, idx),
    updatedTask,
    ...store.tasks.slice(idx + 1)
  ]
  // Reset lastNotified so the nag is muted until after snooze
  const { [id]: _removed, ...remainingNotified } = store.lastNotified
  return { ...store, tasks, lastNotified: remainingNotified }
}

/**
 * Pure helper: update the config portion of the store.
 */
export function updateConfig(store, configPatch) {
  return { ...store, config: { ...store.config, ...configPatch } }
}

/** Recognized repeat schedules. Used both to compute the next due date and to
 *  validate a --repeat value at add-time (so unsupported schedules are rejected
 *  instead of being silently accepted and then no-op'ing on `done`). */
export const REPEAT_KINDS = ['daily', 'weekly', 'weekdays', 'monthly', 'yearly']

/**
 * Is this a repeat schedule the store can actually reschedule? Returns true for
 * the named kinds and for "every N(h|d|w)" intervals. Used to validate input.
 * @param {string} repeat
 * @returns {boolean}
 */
export function isValidRepeat(repeat) {
  if (typeof repeat !== 'string') return false
  const lower = repeat.toLowerCase().trim()
  if (REPEAT_KINDS.includes(lower)) return true
  return /^every\s+(\d+)\s*(d|w|h|days?|weeks?|hours?)$/.test(lower)
}

/**
 * Add `months` calendar months to a date, clamping the day-of-month so that
 * e.g. Jan 31 + 1 month → Feb 28/29 rather than rolling into March. Pure.
 * @param {Date} base
 * @param {number} months
 * @returns {Date}
 */
function addMonths(base, months) {
  const day = base.getDate()
  const target = new Date(base.getTime())
  target.setDate(1) // avoid overflow while shifting the month
  target.setMonth(target.getMonth() + months)
  const daysInTargetMonth = new Date(
    target.getFullYear(), target.getMonth() + 1, 0
  ).getDate()
  target.setDate(Math.min(day, daysInTargetMonth))
  return target
}

/**
 * Compute the next due ISO string for a recurring task.
 * @param {string} currentDue ISO string
 * @param {string} repeat 'daily' | 'weekly' | 'weekdays' | 'monthly' | 'yearly' | 'every Nd'
 * @returns {string|null} ISO string, or null if the schedule is unparseable
 */
export function computeNextDue(currentDue, repeat) {
  const base = new Date(currentDue)
  if (isNaN(base.getTime())) return null
  if (typeof repeat !== 'string') return null

  const lower = repeat.toLowerCase().trim()

  if (lower === 'daily') {
    return new Date(base.getTime() + 24 * 60 * 60 * 1000).toISOString()
  }

  if (lower === 'weekly') {
    return new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
  }

  if (lower === 'weekdays') {
    const next = new Date(base)
    do {
      next.setDate(next.getDate() + 1)
    } while (next.getDay() === 0 || next.getDay() === 6)
    return next.toISOString()
  }

  if (lower === 'monthly') {
    return addMonths(base, 1).toISOString()
  }

  if (lower === 'yearly') {
    return addMonths(base, 12).toISOString()
  }

  // "every Nd" or "every Nw" or "every Nh"
  const everyMatch = lower.match(/^every\s+(\d+)\s*(d|w|h|days?|weeks?|hours?)$/)
  if (everyMatch) {
    const n = parseInt(everyMatch[1], 10)
    const unit = everyMatch[2][0]
    const msMap = { d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000, h: 60 * 60 * 1000 }
    const ms = (msMap[unit] || msMap.d) * n
    return new Date(base.getTime() + ms).toISOString()
  }

  return null
}

// Generate a short unique ID (base36 timestamp + 3 random chars)
function generateId(existingTasks) {
  const existing = new Set(existingTasks.map(t => t.id))
  let id
  do {
    id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  } while (existing.has(id))
  return id
}
