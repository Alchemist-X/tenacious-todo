#!/usr/bin/env node
'use strict'

// todo.js — CLI for tenacious-todo
// Usage: node todo.js <add|list|done|rm> [args...]

import { readStore, writeStore, addTask, markDone, removeTask } from './store.js'

const PRIORITY_ORDER = { high: 0, med: 1, low: 2 }
const PRIORITY_LABEL = { high: '🔴 high', med: '🟡 med', low: '🟢 low' }

function parseArgs(argv) {
  const args = argv.slice(2)
  const cmd = args[0]
  const rest = args.slice(1)
  return { cmd, rest }
}

function parseDue(raw) {
  const d = new Date(raw)
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: "${raw}". Use format: "YYYY-MM-DD HH:MM" or ISO 8601.`)
  }
  return d.toISOString()
}

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

function isOverdue(task) {
  if (!task.due || task.done) return false
  return new Date(task.due) < new Date()
}

function cmdAdd(rest) {
  // node todo.js add "text" [--due "date"] [--priority high|med|low]
  if (!rest.length || rest[0].startsWith('--')) {
    throw new Error('Usage: node todo.js add "<text>" [--due "YYYY-MM-DD HH:MM"] [--priority high|med|low]')
  }

  const text = rest[0]
  let due = null
  let priority = 'med'

  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === '--due' && rest[i + 1]) {
      due = parseDue(rest[++i])
    } else if (rest[i] === '--priority' && rest[i + 1]) {
      const p = rest[++i].toLowerCase()
      if (!['high', 'med', 'low'].includes(p)) {
        throw new Error('Priority must be: high, med, or low')
      }
      priority = p
    }
  }

  const store = readStore()
  const { store: newStore, task } = addTask(store, { text, due, priority })
  writeStore(newStore)
  console.log(`Added task [${task.id}]: "${task.text}"`)
  if (task.due) console.log(`  Due: ${formatDate(task.due)}`)
  console.log(`  Priority: ${task.priority}`)
}

function cmdList() {
  const store = readStore()
  const pending = store.tasks
    .filter(t => !t.done)
    .sort((a, b) => {
      // Overdue first, then by priority, then by due date
      const aOver = isOverdue(a) ? 0 : 1
      const bOver = isOverdue(b) ? 0 : 1
      if (aOver !== bOver) return aOver - bOver
      const aPri = PRIORITY_ORDER[a.priority] ?? 1
      const bPri = PRIORITY_ORDER[b.priority] ?? 1
      if (aPri !== bPri) return aPri - bPri
      if (a.due && b.due) return new Date(a.due) - new Date(b.due)
      if (a.due) return -1
      if (b.due) return 1
      return 0
    })

  if (!pending.length) {
    console.log('No pending tasks. 🎉')
    return
  }

  console.log(`\n${'ID'.padEnd(14)} ${'PRI'.padEnd(8)} ${'STATUS'.padEnd(10)} ${'DUE'.padEnd(22)} TEXT`)
  console.log('─'.repeat(80))
  for (const t of pending) {
    const over = isOverdue(t)
    const status = over ? '⚠️  OVERDUE' : '  pending'
    const id = t.id.padEnd(14)
    const pri = (PRIORITY_LABEL[t.priority] || t.priority).padEnd(8)
    const due = formatDate(t.due).padEnd(22)
    console.log(`${id} ${pri} ${status.padEnd(10)} ${due} ${t.text}`)
  }
  console.log()
}

function cmdDone(rest) {
  const id = rest[0]
  if (!id) throw new Error('Usage: node todo.js done <id>')
  const store = readStore()
  const newStore = markDone(store, id)
  writeStore(newStore)
  console.log(`Marked task [${id}] as done. ✅`)
}

function cmdRm(rest) {
  const id = rest[0]
  if (!id) throw new Error('Usage: node todo.js rm <id>')
  const store = readStore()
  const newStore = removeTask(store, id)
  writeStore(newStore)
  console.log(`Removed task [${id}]. 🗑`)
}

function printHelp() {
  console.log(`
tenacious-todo — a nagging task manager

Commands:
  node todo.js add "<text>" [--due "YYYY-MM-DD HH:MM"] [--priority high|med|low]
  node todo.js list
  node todo.js done <id>
  node todo.js rm <id>
  node todo.js help
`)
}

async function main() {
  try {
    const { cmd, rest } = parseArgs(process.argv)
    switch (cmd) {
      case 'add':  cmdAdd(rest);  break
      case 'list': cmdList();     break
      case 'done': cmdDone(rest); break
      case 'rm':   cmdRm(rest);   break
      case 'help':
      case undefined:
        printHelp()
        break
      default:
        console.error(`Unknown command: "${cmd}". Run: node todo.js help`)
        process.exit(1)
    }
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
}

main()
