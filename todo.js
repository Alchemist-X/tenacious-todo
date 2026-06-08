#!/usr/bin/env node
'use strict'

// todo.js — CLI for tenacious-todo (v2)
// Usage: node todo.js <command> [args...]

import {
  readStore, writeStore,
  addTask, markDone, removeTask, snoozeTask,
  isValidRepeat, REPEAT_KINDS
} from './store.js'
import { isOverdue, isSnoozed, isDueToday } from './filters.js'
import { parseDue, parseSnooze } from './time.js'

// ─── TTY detection ───────────────────────────────────────────────────────────
const USE_COLOR = process.stdout.isTTY

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const C = {
  reset:   USE_COLOR ? '\x1b[0m'    : '',
  bold:    USE_COLOR ? '\x1b[1m'    : '',
  dim:     USE_COLOR ? '\x1b[2m'    : '',
  red:     USE_COLOR ? '\x1b[31m'   : '',
  green:   USE_COLOR ? '\x1b[32m'   : '',
  yellow:  USE_COLOR ? '\x1b[33m'   : '',
  blue:    USE_COLOR ? '\x1b[34m'   : '',
  magenta: USE_COLOR ? '\x1b[35m'   : '',
  cyan:    USE_COLOR ? '\x1b[36m'   : '',
  white:   USE_COLOR ? '\x1b[37m'   : '',
  gray:    USE_COLOR ? '\x1b[90m'   : '',
  bgRed:   USE_COLOR ? '\x1b[41m'   : '',
  bgBlue:  USE_COLOR ? '\x1b[44m'   : '',
}

function color(str, ...codes) {
  if (!USE_COLOR) return str
  return codes.join('') + str + C.reset
}

// ─── Priority metadata ────────────────────────────────────────────────────────
const PRIORITY_ORDER = { high: 0, med: 1, low: 2 }
const PRIORITY_GLYPH = {
  high: color('●', C.red, C.bold),
  med:  color('●', C.yellow),
  low:  color('●', C.green)
}
const PRIORITY_LABEL = {
  high: color('HIGH', C.red, C.bold),
  med:  color('MED ', C.yellow),
  low:  color('LOW ', C.green)
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

function relativeTime(iso) {
  if (!iso) return ''
  const diffMs = new Date(iso).getTime() - Date.now()
  const absDiff = Math.abs(diffMs)
  const future = diffMs > 0

  const minutes = Math.floor(absDiff / 60000)
  const hours   = Math.floor(absDiff / 3600000)
  const days    = Math.floor(absDiff / 86400000)

  let rel
  if (minutes < 1)       rel = 'now'
  else if (minutes < 60) rel = `${minutes}m`
  else if (hours < 24)   rel = `${hours}h`
  else                   rel = `${days}d`

  if (rel === 'now') return color('now', C.yellow, C.bold)
  if (future)        return color(`in ${rel}`, C.cyan)
  return color(`${rel} overdue`, C.red, C.bold)
}

// ─── Sorting ──────────────────────────────────────────────────────────────────
function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    // Done tasks go to bottom
    if (a.done !== b.done) return a.done ? 1 : -1
    // Overdue first
    const aOver = isOverdue(a) ? 0 : 1
    const bOver = isOverdue(b) ? 0 : 1
    if (aOver !== bOver) return aOver - bOver
    // Priority next
    const aPri = PRIORITY_ORDER[a.priority] ?? 1
    const bPri = PRIORITY_ORDER[b.priority] ?? 1
    if (aPri !== bPri) return aPri - bPri
    // Then due date
    if (a.due && b.due) return new Date(a.due) - new Date(b.due)
    if (a.due) return -1
    if (b.due) return 1
    return 0
  })
}

// ─── Rendering ────────────────────────────────────────────────────────────────
const BOX = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│', tm: '┬', bm: '┴',
  lm: '├', rm: '┤', cx: '┼', lr: '─'
}

function pad(str, len) {
  // Strip ANSI for length calculation
  const plain = str.replace(/\x1b\[[0-9;]*m/g, '')
  const diff = len - plain.length
  return diff > 0 ? str + ' '.repeat(diff) : str
}

function renderTable(tasks, showDone = false) {
  if (!tasks.length) return null

  const COL = { id: 14, pri: 6, status: 10, rel: 14, tags: 16, text: 0 }
  // Terminal width, default 100
  const termWidth = process.stdout.columns || 100
  COL.text = Math.max(20, termWidth - COL.id - COL.pri - COL.status - COL.rel - COL.tags - 8)

  const header = [
    color(pad('ID', COL.id), C.bold, C.cyan),
    color(pad('PRI', COL.pri), C.bold, C.cyan),
    color(pad('STATUS', COL.status), C.bold, C.cyan),
    color(pad('DUE', COL.rel), C.bold, C.cyan),
    color(pad('TAGS', COL.tags), C.bold, C.cyan),
    color('TASK', C.bold, C.cyan)
  ].join(color(' │ ', C.gray))

  const totalWidth = COL.id + COL.pri + COL.status + COL.rel + COL.tags + COL.text + 5 * 3
  const divider = color(BOX.h.repeat(totalWidth), C.gray)

  const lines = [`  ${header}`, `  ${divider}`]

  for (const t of tasks) {
    const over    = isOverdue(t)
    const snoozed = isSnoozed(t)

    let statusGlyph, statusStr, rowColorFn
    if (t.done) {
      statusGlyph = color('✓', C.green)
      statusStr   = color('done', C.green, C.dim)
      rowColorFn  = s => color(s, C.dim)
    } else if (over) {
      statusGlyph = color('!', C.red, C.bold)
      statusStr   = color('OVERDUE', C.red, C.bold)
      rowColorFn  = s => s
    } else if (snoozed) {
      statusGlyph = color('z', C.blue)
      statusStr   = color('snoozed', C.blue)
      rowColorFn  = s => color(s, C.dim)
    } else {
      statusGlyph = color('○', C.gray)
      statusStr   = color('pending', C.gray)
      rowColorFn  = s => s
    }

    const priGlyph = PRIORITY_GLYPH[t.priority] || color('●', C.gray)
    const priLabel = PRIORITY_LABEL[t.priority] || color(t.priority, C.gray)
    const tagStr   = t.tags && t.tags.length
      ? color(t.tags.map(g => `#${g}`).join(' ').slice(0, COL.tags - 1), C.magenta)
      : color('—', C.gray)

    const relDue = t.due ? relativeTime(t.due) : color('—', C.gray)

    // Truncate text to column width
    const plainText = t.text.replace(/\x1b\[[0-9;]*m/g, '')
    const truncText = plainText.length > COL.text ? plainText.slice(0, COL.text - 1) + '…' : plainText
    const textDisplay = t.done ? color(truncText, C.dim) : over ? color(truncText, C.white, C.bold) : truncText

    const repeatStr = t.repeat ? color(` ↻${t.repeat}`, C.cyan, C.dim) : ''
    const noteStr   = t.note   ? color(` 📝`, C.yellow, C.dim) : ''

    const row = [
      rowColorFn(pad(t.id, COL.id)),
      // glyph + space + 4-char label = 6 plain chars; pad() measures plain width
      // (ANSI stripped) so the column stays aligned without mangling escapes.
      pad(`${priGlyph} ${priLabel}`, COL.pri),
      pad(statusStr, COL.status),
      pad(relDue, COL.rel),
      pad(tagStr, COL.tags),
      textDisplay + repeatStr + noteStr
    ].join(color(' │ ', C.gray))

    lines.push(`  ${row}`)

    // Note sub-line
    if (t.note) {
      const noteLine = color(`    ${BOX.v}  📝 ${t.note}`, C.dim)
      lines.push(noteLine)
    }
  }

  return lines.join('\n')
}

function printList(tasks, title, showDone = false) {
  const visibleTasks = showDone ? tasks : tasks.filter(t => !t.done)
  const sorted = sortTasks(visibleTasks)

  const pending  = tasks.filter(t => !t.done)
  const overdue  = tasks.filter(t => isOverdue(t))
  const todayTasks = tasks.filter(t => !t.done && isDueToday(t))

  // Header banner
  console.log()
  console.log(color(`  ╭${'─'.repeat(50)}╮`, C.blue))
  console.log(color(`  │`, C.blue) + color(` 📋 ${title}`.padEnd(50), C.bold, C.white) + color('│', C.blue))
  console.log(color(`  ╰${'─'.repeat(50)}╯`, C.blue))
  console.log()

  if (!sorted.length) {
    console.log(color('  ✓ No tasks here.', C.green))
    console.log()
    return
  }

  const table = renderTable(sorted, showDone)
  if (table) console.log(table)

  // Footer summary
  console.log()
  const summaryParts = [
    color(`${pending.length} pending`, pending.length > 0 ? C.white : C.gray),
    overdue.length  ? color(`${overdue.length} overdue`, C.red, C.bold)   : null,
    todayTasks.length ? color(`${todayTasks.length} today`,  C.cyan)         : null,
    tasks.filter(t => t.done).length ? color(`${tasks.filter(t => t.done).length} done`, C.green, C.dim) : null
  ].filter(Boolean).join(color('  ·  ', C.gray))

  console.log(color('  ─'.repeat(30), C.gray))
  console.log(`  ${summaryParts}`)
  console.log()
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function cmdAdd(rest) {
  if (!rest.length || rest[0].startsWith('--')) {
    throw new Error('Usage: node todo.js add "<text>" [--due "DATE"] [--priority high|med|low] [--repeat daily|weekly|weekdays|"every 3d"] [--tag work] [--note "text"]')
  }

  const text = rest[0]
  let due      = null
  let priority = 'med'
  let repeat   = null
  let tags     = []
  let note     = null

  for (let i = 1; i < rest.length; i++) {
    const flag = rest[i]
    const val  = rest[i + 1]

    if (flag === '--due' && val) {
      due = parseDue(val); i++
    } else if (flag === '--priority' && val) {
      const p = val.toLowerCase()
      if (!['high', 'med', 'low'].includes(p)) throw new Error('Priority must be: high, med, or low')
      priority = p; i++
    } else if (flag === '--repeat' && val) {
      const r = val.toLowerCase().trim()
      if (!isValidRepeat(r)) {
        throw new Error(
          `Unsupported --repeat "${val}". Use one of: ${REPEAT_KINDS.join(', ')}, ` +
          `or "every Nd"/"every Nw"/"every Nh".`
        )
      }
      repeat = r; i++
    } else if (flag === '--tag' && val) {
      tags = [...tags, val.toLowerCase().replace(/^#/, '')]; i++
    } else if (flag === '--note' && val) {
      note = val; i++
    }
  }

  if (repeat && !due) {
    throw new Error('--repeat requires --due to set the first occurrence.')
  }

  const store = readStore()
  const { store: newStore, task } = addTask(store, { text, due, priority, repeat, tags, note })
  writeStore(newStore)

  console.log()
  console.log(color('  ✓ Task added', C.green, C.bold))
  console.log(color(`    ID:       `, C.gray) + color(task.id, C.cyan))
  console.log(color(`    Text:     `, C.gray) + color(task.text, C.white, C.bold))
  if (task.due)      console.log(color(`    Due:      `, C.gray) + formatDate(task.due) + '  ' + relativeTime(task.due))
  if (task.repeat)   console.log(color(`    Repeat:   `, C.gray) + color(`↻ ${task.repeat}`, C.cyan))
  if (task.tags.length) console.log(color(`    Tags:     `, C.gray) + color(task.tags.map(t => `#${t}`).join(' '), C.magenta))
  if (task.note)     console.log(color(`    Note:     `, C.gray) + task.note)
  console.log(color(`    Priority: `, C.gray) + (PRIORITY_LABEL[task.priority] || task.priority))
  console.log()
}

function cmdList(rest) {
  const asJson       = rest.includes('--json')
  const filterTag    = getFlagVal(rest, '--tag')
  const filterOnly   = rest.includes('--overdue') ? 'overdue'
                     : rest.includes('--today')   ? 'today'
                     : rest.includes('--done')    ? 'done'
                     : null

  const store = readStore()
  let tasks = store.tasks

  // Apply filters
  if (filterTag) {
    tasks = tasks.filter(t => t.tags && t.tags.includes(filterTag.toLowerCase().replace(/^#/, '')))
  }
  if (filterOnly === 'overdue') {
    tasks = tasks.filter(t => isOverdue(t))
  } else if (filterOnly === 'today') {
    tasks = tasks.filter(t => !t.done && isDueToday(t))
  } else if (filterOnly === 'done') {
    tasks = tasks.filter(t => t.done)
  }

  // Machine-readable output: emit the (filtered) tasks as a JSON array. Never
  // colorized; the store is the source of truth for shape.
  if (asJson) {
    console.log(JSON.stringify(tasks, null, 2))
    return
  }

  const title = [
    'Tenacious Todo',
    filterTag    ? `#${filterTag}` : null,
    filterOnly   ? filterOnly       : null
  ].filter(Boolean).join(' — ')

  const showDone = filterOnly === 'done' || rest.includes('--all')
  printList(tasks, title, showDone || filterOnly === 'done')
}

function cmdDone(rest) {
  const id = rest[0]
  if (!id) throw new Error('Usage: node todo.js done <id>')
  const store = readStore()
  const task = store.tasks.find(t => t.id === id)
  if (!task) throw new Error(`Task "${id}" not found.`)

  const newStore = markDone(store, id)
  writeStore(newStore)

  console.log()
  console.log(color(`  ✓ Done: "${task.text}"`, C.green, C.bold))
  if (task.repeat) {
    const newer = newStore.tasks.find(t => t.text === task.text && !t.done && t.id !== id)
    if (newer) {
      console.log(color(`  ↻ Next occurrence scheduled: `, C.cyan) + formatDate(newer.due) + ' [' + newer.id + ']')
    }
  }
  console.log()
}

function cmdRm(rest) {
  const id = rest[0]
  if (!id) throw new Error('Usage: node todo.js rm <id>')
  const store = readStore()
  const task = store.tasks.find(t => t.id === id)
  if (!task) throw new Error(`Task "${id}" not found.`)

  const newStore = removeTask(store, id)
  writeStore(newStore)
  console.log()
  console.log(color(`  ✗ Removed: "${task.text}"`, C.red))
  console.log()
}

function cmdSnooze(rest) {
  const id     = rest[0]
  const rawTime = rest[1]
  if (!id || !rawTime) {
    throw new Error('Usage: node todo.js snooze <id> <30m|2h|tomorrow|"YYYY-MM-DD HH:MM">')
  }

  const until = parseSnooze(rawTime)
  const store = readStore()
  const task = store.tasks.find(t => t.id === id)
  if (!task) throw new Error(`Task "${id}" not found.`)

  const newStore = snoozeTask(store, id, until)
  writeStore(newStore)

  console.log()
  console.log(color(`  💤 Snoozed: "${task.text}"`, C.blue, C.bold))
  console.log(color(`     Until:  `, C.gray) + formatDate(until) + '  ' + relativeTime(until))
  console.log()
}

function cmdStats() {
  const store  = readStore()
  const tasks  = store.tasks
  const total  = tasks.length
  const done   = tasks.filter(t => t.done)
  const pending = tasks.filter(t => !t.done)
  const overdue = tasks.filter(t => isOverdue(t))

  const byPriority = { high: 0, med: 0, low: 0 }
  for (const t of pending) {
    byPriority[t.priority] = (byPriority[t.priority] || 0) + 1
  }

  const completionRate = total > 0 ? Math.round((done.length / total) * 100) : 0

  // Streak: consecutive days (ending today) where all tasks due that day were marked done
  const streak = computeStreak(tasks)

  console.log()
  console.log(color('  ╭─────────────────────────────────────────╮', C.blue))
  console.log(color('  │', C.blue) + color('         📊 Tenacious Todo Stats          ', C.bold, C.white) + color('│', C.blue))
  console.log(color('  ╰─────────────────────────────────────────╯', C.blue))
  console.log()
  console.log(color('  Tasks', C.bold, C.white))
  console.log(color('    Total:       ', C.gray) + color(total, C.white, C.bold))
  console.log(color('    Pending:     ', C.gray) + color(pending.length, C.yellow))
  console.log(color('    Overdue:     ', C.gray) + (overdue.length ? color(overdue.length, C.red, C.bold) : color('0', C.gray)))
  console.log(color('    Done:        ', C.gray) + color(done.length, C.green))
  console.log()
  console.log(color('  Pending by Priority', C.bold, C.white))
  console.log(color('    High:        ', C.gray) + color(byPriority.high, C.red, C.bold))
  console.log(color('    Med:         ', C.gray) + color(byPriority.med, C.yellow))
  console.log(color('    Low:         ', C.gray) + color(byPriority.low, C.green))
  console.log()
  console.log(color('  Progress', C.bold, C.white))
  console.log(color('    Completion:  ', C.gray) + renderBar(completionRate) + color(` ${completionRate}%`, C.white))
  console.log(color('    Streak:      ', C.gray) + color(`${streak} day${streak === 1 ? '' : 's'}`, streak >= 3 ? C.green : C.yellow) + (streak >= 3 ? color(' 🔥', C.yellow) : ''))
  console.log()
}

function renderBar(pct) {
  const filled = Math.round(pct / 5)
  const empty  = 20 - filled
  return color('[', C.gray)
    + color('█'.repeat(filled), C.green)
    + color('░'.repeat(empty), C.gray)
    + color(']', C.gray)
}

function computeStreak(tasks) {
  // Find days (YYYY-MM-DD) where at least one task was completed
  const doneDays = new Set(
    tasks
      .filter(t => t.done && t.doneAt)
      .map(t => t.doneAt.slice(0, 10))
  )
  if (!doneDays.size) return 0

  let streak = 0
  const today = new Date()
  for (let i = 0; i < 365; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    if (doneDays.has(key)) {
      streak++
    } else {
      break
    }
  }
  return streak
}

function cmdToday() {
  const store = readStore()
  const tasks = store.tasks.filter(t => !t.done && isDueToday(t))
  printList(tasks, "Today's Tasks", false)
}

function cmdOverdue() {
  const store = readStore()
  const tasks = store.tasks.filter(t => isOverdue(t))
  printList(tasks, 'Overdue Tasks', false)
}

// ─── Argument helpers ─────────────────────────────────────────────────────────
function getFlagVal(args, flag) {
  const idx = args.indexOf(flag)
  if (idx === -1 || !args[idx + 1]) return null
  return args[idx + 1]
}

function parseArgs(argv) {
  const args = argv.slice(2)
  const cmd  = args[0]
  const rest = args.slice(1)
  return { cmd, rest }
}

// ─── Help ─────────────────────────────────────────────────────────────────────
function printHelp() {
  console.log()
  console.log(color(' ╭─────────────────────────────────────────────────────────╮', C.blue))
  console.log(color(' │', C.blue) + color('           📋 tenacious-todo  v2.0                        ', C.bold, C.white) + color('│', C.blue))
  console.log(color(' │', C.blue) + color('           A nagging task manager                         ', C.dim)          + color('│', C.blue))
  console.log(color(' ╰─────────────────────────────────────────────────────────╯', C.blue))
  console.log()
  console.log(color(' COMMANDS', C.bold, C.yellow))
  console.log()

  const cmds = [
    ['add "<text>"', '[--due "DATE"] [--priority high|med|low]', 'Add a new task'],
    ['',             '[--repeat daily|weekly|weekdays|"every 3d"]', ''],
    ['',             '[--tag work] [--note "text"]', ''],
    ['list',         '[--tag TAG] [--overdue] [--today] [--done]', 'List tasks with filters'],
    ['',             '[--all] [--json]', ''],
    ['today',        '', 'Show tasks due today'],
    ['overdue',      '', 'Show all overdue tasks'],
    ['done <id>',    '', 'Mark a task complete'],
    ['rm <id>',      '', 'Delete a task'],
    ['snooze <id>',  '<30m|2h|tomorrow|"DATE">', 'Defer reminders'],
    ['stats',        '', 'Show completion stats & streak'],
    ['help',         '', 'Show this help'],
  ]

  for (const [cmd, args, desc] of cmds) {
    if (cmd) {
      console.log(
        '  ' + color(('node todo.js ' + cmd).padEnd(28), C.cyan) +
        color(args.padEnd(48), C.gray) +
        (desc ? color(desc, C.white) : '')
      )
    } else {
      console.log('  ' + ' '.repeat(28) + color(args, C.gray))
    }
  }

  console.log()
  console.log(color(' DAEMON', C.bold, C.yellow))
  console.log(color('  node daemon.js --once', C.cyan) + color('   Fire due notifications once', C.gray))
  console.log(color('  node daemon.js', C.cyan)        + color('        Poll every 60s (foreground)', C.gray))
  console.log(color('  bash install-daemon.sh', C.cyan) + color('  Install as macOS launchd agent', C.gray))
  console.log()
  console.log(color(' EXAMPLES', C.bold, C.yellow))
  console.log(color('  node todo.js add "Ship feature" --due "2026-06-10 17:00" --priority high --tag work', C.dim))
  console.log(color('  node todo.js add "Daily standup" --due "2026-06-07 09:00" --repeat weekdays', C.dim))
  console.log(color('  node todo.js snooze <id> 2h', C.dim))
  console.log(color('  node todo.js list --overdue', C.dim))
  console.log(color('  node todo.js list --tag work', C.dim))
  console.log()
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  try {
    const { cmd, rest } = parseArgs(process.argv)
    switch (cmd) {
      case 'add':     cmdAdd(rest);    break
      case 'list':    cmdList(rest);   break
      case 'today':   cmdToday();      break
      case 'overdue': cmdOverdue();    break
      case 'done':    cmdDone(rest);   break
      case 'rm':      cmdRm(rest);     break
      case 'snooze':  cmdSnooze(rest); break
      case 'stats':   cmdStats();      break
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        printHelp()
        break
      default:
        console.error(color(`\n  Error: Unknown command "${cmd}". Run: node todo.js help\n`, C.red))
        process.exit(1)
    }
  } catch (err) {
    console.error(color(`\n  Error: ${err.message}\n`, C.red))
    process.exit(1)
  }
}

main()
