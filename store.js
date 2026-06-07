'use strict'

// store.js — immutable JSON task store (~/.tenacious-todo/tasks.json)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = join(homedir(), '.tenacious-todo')
const TASKS_FILE = join(DATA_DIR, 'tasks.json')

function ensureDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true })
  }
}

/** @returns {{ tasks: Task[], lastNotified: Record<string,number> }} */
export function readStore() {
  ensureDir()
  if (!existsSync(TASKS_FILE)) {
    return { tasks: [], lastNotified: {} }
  }
  try {
    const raw = readFileSync(TASKS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      lastNotified: parsed.lastNotified && typeof parsed.lastNotified === 'object'
        ? parsed.lastNotified
        : {}
    }
  } catch (err) {
    throw new Error(`Failed to read task store: ${err.message}`)
  }
}

/** @param {{ tasks: Task[], lastNotified: Record<string,number> }} store */
export function writeStore(store) {
  ensureDir()
  try {
    writeFileSync(TASKS_FILE, JSON.stringify(store, null, 2), 'utf8')
  } catch (err) {
    throw new Error(`Failed to write task store: ${err.message}`)
  }
}

/**
 * Pure helper: add a new task and return a NEW store object.
 * @param {{ tasks: Task[], lastNotified: Record<string,number> }} store
 * @param {{ text: string, due?: string, priority?: string }} opts
 * @returns {{ store: object, task: Task }}
 */
export function addTask(store, { text, due, priority }) {
  const id = generateId(store.tasks)
  const task = {
    id,
    text,
    due: due || null,
    priority: priority || 'med',
    done: false,
    createdAt: new Date().toISOString()
  }
  return {
    store: { ...store, tasks: [...store.tasks, task] },
    task
  }
}

/**
 * Pure helper: mark task done and return a NEW store.
 */
export function markDone(store, id) {
  const idx = store.tasks.findIndex(t => t.id === id)
  if (idx === -1) throw new Error(`Task with id "${id}" not found.`)
  const updatedTask = { ...store.tasks[idx], done: true, doneAt: new Date().toISOString() }
  const tasks = [
    ...store.tasks.slice(0, idx),
    updatedTask,
    ...store.tasks.slice(idx + 1)
  ]
  // Remove lastNotified entry for this task
  const { [id]: _removed, ...remainingNotified } = store.lastNotified
  return { ...store, tasks, lastNotified: remainingNotified }
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

// Generate a short unique ID (base36 timestamp + 3 random chars)
function generateId(existingTasks) {
  const existing = new Set(existingTasks.map(t => t.id))
  let id
  do {
    id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  } while (existing.has(id))
  return id
}
