#!/usr/bin/env node
'use strict'

// eval/eval.mjs — strict pass/fail eval harness for tenacious-todo.
// Zero deps. Node 23 (child_process, fs, test runner via subprocess).
//
// Run from repo root:   node eval/eval.mjs
//
// Isolation: every store-touching check runs against a FRESH temp dir pointed at
// by the env var TENACIOUS_HOME. The harness verifies the project actually honors
// TENACIOUS_HOME before mutating anything; if it does not, the store-dependent
// criteria fail (and the real ~/.tenacious-todo is never written by this harness).

import { spawnSync } from 'node:child_process'
import {
  mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync,
  mkdirSync, chmodSync, readdirSync
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const TODO = join(REPO, 'todo.js')
const DAEMON = join(REPO, 'daemon.js')
const NODE = process.execPath
const REAL_HOME_STORE = join(homedir(), '.tenacious-todo')

const ANSI_RE = /\x1b\[[0-9;]*m/

// ─── result accounting ────────────────────────────────────────────────────────
const results = []
function pass(id, msg) { results.push({ id, ok: true, msg }); console.log(`PASS ${id}: ${msg}`) }
function fail(id, msg) { results.push({ id, ok: false, msg }); console.log(`FAIL ${id}: ${msg}`) }

// ─── temp store management ────────────────────────────────────────────────────
const tempDirs = []
function freshHome() {
  const d = mkdtempSync(join(tmpdir(), 'ttodo-eval-'))
  tempDirs.push(d)
  return d
}
function cleanup() {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })
process.on('SIGTERM', () => { cleanup(); process.exit(1) })

// ─── command runner (always isolated) ─────────────────────────────────────────
function run(file, args, { home, extraEnv = {}, cwd = REPO, timeout = 20000 } = {}) {
  const env = { ...process.env, TENACIOUS_HOME: home, ...extraEnv }
  const r = spawnSync(NODE, [file, ...args], {
    cwd, env, encoding: 'utf8', timeout
  })
  return {
    code: r.status,
    signal: r.signal,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error
  }
}

// Locate the store JSON for a given isolated home. The project (correctly) should
// write to <home>/tasks.json. Be tolerant of a couple of plausible layouts so a
// genuinely-isolated impl is not mis-flagged.
function findStoreFile(home) {
  const candidates = [
    join(home, 'tasks.json'),
    join(home, '.tenacious-todo', 'tasks.json')
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}
function readStoreFile(home) {
  const f = findStoreFile(home)
  if (!f) return null
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null }
}

// Try `list --json`; return parsed array/object if it really emits JSON, else null.
function listJson(home, extraArgs = []) {
  const r = run(TODO, ['list', '--json', ...extraArgs], { home })
  if (r.code !== 0) return null
  const out = r.stdout.trim()
  if (!out || (out[0] !== '{' && out[0] !== '[')) return null
  try {
    const parsed = JSON.parse(out)
    return parsed
  } catch { return null }
}

// Extract tasks array from either listJson shape or a raw store object.
function tasksFrom(jsonOrStore) {
  if (Array.isArray(jsonOrStore)) return jsonOrStore
  if (jsonOrStore && Array.isArray(jsonOrStore.tasks)) return jsonOrStore.tasks
  return null
}

// ─── ISOLATION GUARD ──────────────────────────────────────────────────────────
// Returns true if the project honors TENACIOUS_HOME (an add lands in the temp dir
// and NOT in the real ~/.tenacious-todo). If false, store-dependent criteria are
// failed wholesale and we never mutate the real store.
let ISOLATION_OK = false
let ISOLATION_REASON = ''
function checkIsolation() {
  const home = freshHome()
  const sentinel = `__ISO_PROBE_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const r = run(TODO, ['add', sentinel, '--due', '2026-06-10 17:00', '--priority', 'high'], { home })
  if (r.code !== 0 && r.error) {
    ISOLATION_REASON = `could not spawn todo.js (${r.error.message})`
    return
  }
  const store = readStoreFile(home)
  const tasks = store && Array.isArray(store.tasks) ? store.tasks : []
  const landedInIsolated = tasks.some(t => t && t.text === sentinel)
  if (!landedInIsolated) {
    // Did it leak into the REAL store? If so, the project ignores TENACIOUS_HOME.
    let leaked = false
    const realFile = join(REAL_HOME_STORE, 'tasks.json')
    if (existsSync(realFile)) {
      try {
        const real = JSON.parse(readFileSync(realFile, 'utf8'))
        leaked = Array.isArray(real.tasks) && real.tasks.some(t => t && t.text === sentinel)
        if (leaked) {
          // Clean our probe out of the real store; the harness must not pollute it.
          real.tasks = real.tasks.filter(t => !(t && t.text === sentinel))
          writeFileSync(realFile, JSON.stringify(real, null, 2))
        }
      } catch { /* ignore */ }
    }
    ISOLATION_REASON = leaked
      ? 'project ignores TENACIOUS_HOME: add wrote to the REAL ~/.tenacious-todo instead of the isolated temp dir (store path is hardcoded to ~/.tenacious-todo)'
      : `add did not produce an isolated tasks.json under ${home} (no store written there)`
    return
  }
  ISOLATION_OK = true
}

// Guard helper for store-dependent criteria.
function requireIsolation(id) {
  if (ISOLATION_OK) return true
  fail(id, `isolation prerequisite not met — ${ISOLATION_REASON}`)
  return false
}

// ─── helpers for seeding via store file (only used when isolation is honored) ──
function isoOffsetHours(h) {
  return new Date(Date.now() + h * 3600 * 1000).toISOString()
}

// ════════════════════════════════════════════════════════════════════════════
// C1 — help
// ════════════════════════════════════════════════════════════════════════════
function c1() {
  const id = 'C1'
  const REQUIRED = ['add', 'list', 'done', 'rm', 'snooze', 'stats', 'today', 'overdue']
  const variants = [['--help'], ['-h'], []]
  const problems = []
  for (const args of variants) {
    const label = args.length ? args.join(' ') : '(no args)'
    const home = freshHome()
    const r = run(TODO, args, { home })
    if (r.code !== 0) { problems.push(`"${label}" exited ${r.code} (expected 0)`); continue }
    const out = r.stdout
    if (!out || !out.trim()) { problems.push(`"${label}" printed nothing to STDOUT`); continue }
    const lower = out.toLowerCase()
    const missing = REQUIRED.filter(c => !new RegExp(`\\b${c}\\b`).test(lower))
    if (missing.length) problems.push(`"${label}" usage missing commands: ${missing.join(', ')}`)
  }
  if (problems.length) fail(id, problems.join(' | '))
  else pass(id, '--help, -h, and no-arg each exit 0 and print usage listing all 8 commands to STDOUT')
}

// ════════════════════════════════════════════════════════════════════════════
// C2 — round-trip add/list/done/rm
// ════════════════════════════════════════════════════════════════════════════
function c2() {
  const id = 'C2'
  if (!requireIsolation(id)) return
  const home = freshHome()
  const text = 'RoundTrip task'
  const due = '2026-06-10 17:00'

  const add = run(TODO, ['add', text, '--due', due, '--priority', 'high'], { home })
  if (add.code !== 0) return fail(id, `add exited ${add.code}: ${add.stderr.trim() || add.stdout.trim()}`)

  let store = readStoreFile(home)
  let tasks = tasksFrom(listJson(home)) || (store ? store.tasks : null)
  if (!tasks) return fail(id, 'could not read tasks after add (no list --json and no readable store)')
  const t = tasks.find(x => x.text === text)
  if (!t) return fail(id, `added task not present in list (have: ${tasks.map(x => x.text).join(', ') || 'none'})`)
  if (t.priority !== 'high') return fail(id, `priority not persisted: expected "high", got "${t.priority}"`)
  if (!t.due || new Date(t.due).getTime() !== new Date(due).getTime()) {
    return fail(id, `due not persisted correctly: expected ${new Date(due).toISOString()}, got ${t.due}`)
  }
  const tid = t.id
  if (!tid) return fail(id, 'task has no id')

  const done = run(TODO, ['done', tid], { home })
  if (done.code !== 0) return fail(id, `done exited ${done.code}: ${done.stderr.trim()}`)
  store = readStoreFile(home)
  const afterDone = (store ? store.tasks : []).find(x => x.id === tid)
  if (!afterDone || afterDone.done !== true) return fail(id, 'done did not mark the task done in the store')

  const rm = run(TODO, ['rm', tid], { home })
  if (rm.code !== 0) return fail(id, `rm exited ${rm.code}: ${rm.stderr.trim()}`)
  store = readStoreFile(home)
  const afterRm = (store ? store.tasks : []).find(x => x.id === tid)
  if (afterRm) return fail(id, 'rm did not remove the task from the store')

  pass(id, 'add persists text/priority/due; done marks done; rm removes')
}

// ════════════════════════════════════════════════════════════════════════════
// C3 — recurring (weekdays reschedules; monthly must not silently no-op)
// ════════════════════════════════════════════════════════════════════════════
function c3() {
  const id = 'C3'
  if (!requireIsolation(id)) return

  // Part A: weekdays must create a strictly-later next occurrence on done.
  {
    const home = freshHome()
    const text = 'Standup weekdays'
    const due = '2026-06-08 09:00' // a Monday
    const add = run(TODO, ['add', text, '--due', due, '--repeat', 'weekdays'], { home })
    if (add.code !== 0) return fail(id, `weekdays add exited ${add.code}: ${add.stderr.trim() || add.stdout.trim()}`)
    let store = readStoreFile(home)
    const orig = (store ? store.tasks : []).find(x => x.text === text)
    if (!orig) return fail(id, 'weekdays task not added')
    const done = run(TODO, ['done', orig.id], { home })
    if (done.code !== 0) return fail(id, `weekdays done exited ${done.code}: ${done.stderr.trim()}`)
    store = readStoreFile(home)
    const next = (store ? store.tasks : []).find(x => x.text === text && !x.done && x.id !== orig.id)
    if (!next) return fail(id, 'weekdays: no NEXT occurrence created after done (expected a new pending task)')
    if (!next.due || new Date(next.due) <= new Date(orig.due)) {
      return fail(id, `weekdays: next occurrence due (${next.due}) is not strictly later than original (${orig.due})`)
    }
  }

  // Part B: monthly must NOT silently no-op. Acceptable: reject at add-time OR reschedule.
  {
    const home = freshHome()
    const text = 'Rent monthly'
    const due = '2026-06-01 09:00'
    const add = run(TODO, ['add', text, '--due', due, '--repeat', 'monthly'], { home })

    if (add.code !== 0) {
      // Rejected at add-time — acceptable IF it has a clear error and added nothing.
      const errOut = (add.stderr + add.stdout).toLowerCase()
      const store = readStoreFile(home)
      const added = store && store.tasks.some(x => x.text === text)
      if (added) return fail(id, 'monthly: add exited non-zero but still added the task (inconsistent)')
      if (!/monthly|repeat|unsupported|invalid|unknown|not supported/.test(errOut)) {
        return fail(id, `monthly: rejected but error message is not clear about repeat/monthly: "${(add.stderr || add.stdout).trim()}"`)
      }
      return pass(id, 'weekdays reschedules; monthly is rejected at add-time with a clear error')
    }

    // add succeeded → on done it MUST create a later occurrence (no silent no-op).
    let store = readStoreFile(home)
    const orig = (store ? store.tasks : []).find(x => x.text === text)
    if (!orig) return fail(id, 'monthly: add succeeded but task not in store')
    const done = run(TODO, ['done', orig.id], { home })
    if (done.code !== 0) {
      return fail(id, `monthly: done exited ${done.code} (a clear error here is only acceptable at add-time, not after the task was accepted)`)
    }
    store = readStoreFile(home)
    const next = (store ? store.tasks : []).find(x => x.text === text && !x.done && x.id !== orig.id)
    if (!next) {
      return fail(id, 'monthly SILENT NO-OP: task accepted at add-time but done created no next occurrence and raised no error (known bug)')
    }
    if (!next.due || new Date(next.due) <= new Date(orig.due)) {
      return fail(id, `monthly: next occurrence due (${next.due}) not strictly later than original (${orig.due})`)
    }
  }

  pass(id, 'weekdays reschedules to a later occurrence; monthly reschedules correctly')
}

// ════════════════════════════════════════════════════════════════════════════
// C4 — snooze defers; daemon --once does NOT notify a snoozed task
// ════════════════════════════════════════════════════════════════════════════
function c4() {
  const id = 'C4'
  if (!requireIsolation(id)) return
  const home = freshHome()

  // Add a PAST-due task so it would otherwise be notified.
  const text = 'Snooze me'
  const past = isoOffsetHours(-3)
  const add = run(TODO, ['add', text, '--due', past, '--priority', 'high'], { home })
  if (add.code !== 0) return fail(id, `add exited ${add.code}: ${add.stderr.trim()}`)
  let store = readStoreFile(home)
  const t = (store ? store.tasks : []).find(x => x.text === text)
  if (!t) return fail(id, 'task not added')

  const sn = run(TODO, ['snooze', t.id, '2h'], { home })
  if (sn.code !== 0) return fail(id, `snooze exited ${sn.code}: ${sn.stderr.trim()}`)
  store = readStoreFile(home)
  const after = (store ? store.tasks : []).find(x => x.id === t.id)
  if (!after || !after.snoozeUntil) return fail(id, 'snooze did not set snoozeUntil on the task')
  const deltaH = (new Date(after.snoozeUntil).getTime() - Date.now()) / 3600000
  if (deltaH < 1.5 || deltaH > 2.5) {
    return fail(id, `snooze 2h math off: snoozeUntil is ${deltaH.toFixed(2)}h from now (expected ~2h)`)
  }

  // daemon --once must NOT notify the snoozed task.
  const stubPath = makeOsascriptStub()
  const d = run(DAEMON, ['--once'], { home, extraEnv: { PATH: `${stubPath}:${process.env.PATH}` } })
  if (d.code !== 0) return fail(id, `daemon --once exited ${d.code}: ${d.stderr.trim()}`)
  const log = d.stdout + d.stderr
  if (new RegExp(`Notified:[^\\n]*${escapeRe(t.id)}`).test(log) || /Notified:[^\n]*Snooze me/.test(log)) {
    return fail(id, 'daemon notified a SNOOZED task (it should be skipped)')
  }
  pass(id, 'snooze 2h sets snoozeUntil ~2h ahead; daemon --once skips the snoozed task')
}

// ════════════════════════════════════════════════════════════════════════════
// C5 — daemon --once: notifies past-due; skips under quiet hours
// ════════════════════════════════════════════════════════════════════════════
function c5() {
  const id = 'C5'
  if (!requireIsolation(id)) return

  const stubPath = makeOsascriptStub()

  // Part A: past-due, non-snoozed → exit 0 + a notification attempt logged.
  let home = freshHome()
  const add = run(TODO, ['add', 'Past due nag', '--due', isoOffsetHours(-5), '--priority', 'high'], { home })
  if (add.code !== 0) return fail(id, `seed add exited ${add.code}: ${add.stderr.trim()}`)
  const dA = run(DAEMON, ['--once'], { home, extraEnv: { PATH: `${stubPath}:${process.env.PATH}` } })
  if (dA.code !== 0) return fail(id, `daemon --once exited ${dA.code}: ${dA.stderr.trim()}`)
  const logA = dA.stdout + dA.stderr
  const attempted = /Notified:/.test(logA) || /Failed to notify/i.test(logA)
  if (!attempted) {
    return fail(id, `daemon --once exited 0 but logged no notification attempt for a past-due task. stdout: ${truncate(logA)}`)
  }

  // Part B: quiet hours covering "now" → exit 0 + a skip logged, NO notification.
  home = freshHome()
  const add2 = run(TODO, ['add', 'Quiet nag', '--due', isoOffsetHours(-5), '--priority', 'high'], { home })
  if (add2.code !== 0) return fail(id, `quiet seed add exited ${add2.code}: ${add2.stderr.trim()}`)
  // Configure quiet hours to cover every hour: store.config with start=0,end=24-ish.
  // The daemon treats start>end as a midnight-crossing window; setting start=0,end=23
  // covers hour 0..22, and start=hour-1.. is fragile. Use an all-day window: a window
  // [start, end) on the same day. To guarantee "now" is inside regardless of the hour,
  // set start=0 and end=24 is invalid (hours are 0-23); instead set quiet to a window
  // that always contains the current hour.
  const nowHour = new Date().getHours()
  const cfgWritten = writeConfig(home, {
    quietHoursStart: nowHour,
    quietHoursEnd: (nowHour + 1) % 24 === 0 ? 23 : (nowHour + 1) % 24
  })
  if (!cfgWritten) return fail(id, 'could not write quiet-hours config into the isolated store')
  const dB = run(DAEMON, ['--once'], { home, extraEnv: { PATH: `${stubPath}:${process.env.PATH}` } })
  if (dB.code !== 0) return fail(id, `daemon --once (quiet) exited ${dB.code}: ${dB.stderr.trim()}`)
  const logB = dB.stdout + dB.stderr
  if (/Notified:/.test(logB)) {
    return fail(id, 'daemon notified during quiet hours (should have skipped)')
  }
  if (!/quiet/i.test(logB) && !/skip/i.test(logB)) {
    return fail(id, `quiet hours active but no skip logged. stdout: ${truncate(logB)}`)
  }

  pass(id, 'daemon --once: notifies past-due (exit 0, attempt logged); skips & logs under quiet hours')
}

// Configure quiet hours by reading the isolated store, patching config, writing back.
// Returns true on success. Only used after isolation is confirmed.
function writeConfig(home, configPatch) {
  const f = findStoreFile(home)
  let store
  if (f) {
    try { store = JSON.parse(readFileSync(f, 'utf8')) } catch { store = null }
  }
  if (!store) return false
  const next = { ...store, config: { ...(store.config || {}), ...configPatch } }
  try {
    writeFileSync(f, JSON.stringify(next, null, 2))
    return true
  } catch { return false }
}

// ════════════════════════════════════════════════════════════════════════════
// C6 — list filters return correct subsets
// ════════════════════════════════════════════════════════════════════════════
function c6() {
  const id = 'C6'
  if (!requireIsolation(id)) return
  const home = freshHome()

  // Seed via CLI add for non-done tasks; mark one done via the CLI.
  const seeds = [
    { text: 'C6 overdue work', due: isoOffsetHours(-48), pri: 'high', tag: 'work' },
    { text: 'C6 due today',    due: isoOffsetHours(2),   pri: 'med',  tag: 'home' },
    { text: 'C6 future work',  due: isoOffsetHours(120), pri: 'low',  tag: 'work' },
    { text: 'C6 will be done', due: isoOffsetHours(-24), pri: 'med',  tag: 'errand' }
  ]
  for (const s of seeds) {
    const r = run(TODO, ['add', s.text, '--due', s.due, '--priority', s.pri, '--tag', s.tag], { home })
    if (r.code !== 0) return fail(id, `seed add "${s.text}" exited ${r.code}: ${r.stderr.trim()}`)
  }
  // Mark the "will be done" task done.
  let store = readStoreFile(home)
  const doneTask = (store ? store.tasks : []).find(x => x.text === 'C6 will be done')
  if (!doneTask) return fail(id, 'seeding failed: done-target task missing')
  const dr = run(TODO, ['done', doneTask.id], { home })
  if (dr.code !== 0) return fail(id, `done seed exited ${dr.code}: ${dr.stderr.trim()}`)

  // Helper: get the set of task texts a filter returns. Prefer --json; else parse
  // the colorless (non-TTY) list output for our known seed texts.
  function filterTexts(args) {
    const j = listJson(home, args)
    const fromJson = tasksFrom(j)
    if (fromJson) return new Set(fromJson.map(t => t.text))
    const r = run(TODO, ['list', ...args], { home })
    if (r.code !== 0) return null
    const out = r.stdout
    const found = new Set()
    for (const s of seeds) if (out.includes(s.text)) found.add(s.text)
    return found
  }

  const checks = [
    { name: 'list --overdue', args: ['--overdue'],
      want: ['C6 overdue work'],
      forbid: ['C6 due today', 'C6 future work', 'C6 will be done'] },
    { name: 'list --today', args: ['--today'],
      want: ['C6 due today'],
      forbid: ['C6 overdue work', 'C6 future work', 'C6 will be done'] },
    { name: 'list --done', args: ['--done'],
      want: ['C6 will be done'],
      forbid: ['C6 overdue work', 'C6 due today', 'C6 future work'] },
    { name: 'list --tag work', args: ['--tag', 'work'],
      want: ['C6 overdue work', 'C6 future work'],
      forbid: ['C6 due today', 'C6 will be done'] }
  ]

  const problems = []
  for (const c of checks) {
    const got = filterTexts(c.args)
    if (got === null) { problems.push(`${c.name}: command failed`); continue }
    const missing = c.want.filter(w => !got.has(w))
    const leaked = c.forbid.filter(f => got.has(f))
    if (missing.length) problems.push(`${c.name} missing ${JSON.stringify(missing)}`)
    if (leaked.length) problems.push(`${c.name} wrongly included ${JSON.stringify(leaked)}`)
  }

  if (problems.length) fail(id, problems.join(' | '))
  else pass(id, 'list --overdue/--today/--done/--tag each return the correct subset')
}

// ════════════════════════════════════════════════════════════════════════════
// C7 — no-TTY output has no ANSI escapes
// ════════════════════════════════════════════════════════════════════════════
function c7() {
  const id = 'C7'
  if (!requireIsolation(id)) return
  const home = freshHome()
  // Seed at least one task so the table actually renders (max opportunity for color).
  const add = run(TODO, ['add', 'Color check', '--due', isoOffsetHours(-2), '--priority', 'high', '--tag', 'work'], { home })
  if (add.code !== 0) return fail(id, `seed add exited ${add.code}: ${add.stderr.trim()}`)
  // spawnSync pipes stdout → not a TTY, exactly the piped case.
  const r = run(TODO, ['list'], { home })
  if (r.code !== 0) return fail(id, `list exited ${r.code}: ${r.stderr.trim()}`)
  if (ANSI_RE.test(r.stdout)) {
    const sample = JSON.stringify(r.stdout.match(ANSI_RE)[0])
    return fail(id, `piped (non-TTY) list output contains ANSI escape sequences (e.g. ${sample})`)
  }
  pass(id, 'piped non-TTY list output contains no ANSI escape sequences')
}

// ════════════════════════════════════════════════════════════════════════════
// C8 — packaging: bin + shebang + npx-able --help
// ════════════════════════════════════════════════════════════════════════════
function c8() {
  const id = 'C8'
  const pkgPath = join(REPO, 'package.json')
  if (!existsSync(pkgPath)) return fail(id, 'no package.json at repo root')
  let pkg
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch (e) {
    return fail(id, `package.json is not valid JSON: ${e.message}`)
  }
  if (!pkg.bin) return fail(id, 'package.json has no "bin" field')

  // bin may be a string or an object map.
  let binTargets = []
  if (typeof pkg.bin === 'string') binTargets = [pkg.bin]
  else if (typeof pkg.bin === 'object') binTargets = Object.values(pkg.bin)
  if (!binTargets.length) return fail(id, '"bin" field is empty')

  // Pick the first existing target; verify shebang.
  let chosen = null
  for (const rel of binTargets) {
    const abs = resolve(REPO, rel)
    if (existsSync(abs)) { chosen = abs; break }
  }
  if (!chosen) return fail(id, `bin target(s) do not exist: ${binTargets.join(', ')}`)

  const head = readFileSync(chosen, 'utf8').split('\n', 1)[0]
  if (head.trim() !== '#!/usr/bin/env node') {
    return fail(id, `bin target ${chosen} first line is not "#!/usr/bin/env node" (got: ${JSON.stringify(head)})`)
  }

  // Run the bin with --help in an isolated home; must exit 0 and print usage.
  const home = freshHome()
  const r = run(chosen, ['--help'], { home })
  if (r.code !== 0) return fail(id, `running bin --help exited ${r.code}: ${r.stderr.trim()}`)
  if (!/\b(add)\b/.test(r.stdout.toLowerCase()) || !r.stdout.trim()) {
    return fail(id, 'bin --help produced no usable usage output')
  }
  pass(id, `package.json bin present; target has node shebang; bin --help works (npx-able)`)
}

// ════════════════════════════════════════════════════════════════════════════
// C9 — node --test runs >=4 passing tests for pure store ops
// ════════════════════════════════════════════════════════════════════════════
function c9() {
  const id = 'C9'
  // Discover candidate test files the project ships.
  const testFiles = discoverTestFiles(REPO)
  if (!testFiles.length) {
    return fail(id, 'no test files found (expected *.test.js / test/*.js covering computeNextDue, filtering, snooze math)')
  }
  const home = freshHome()
  const env = { ...process.env, TENACIOUS_HOME: home }
  const r = spawnSync(NODE, ['--test', '--test-reporter=tap', ...testFiles], {
    cwd: REPO, env, encoding: 'utf8', timeout: 60000
  })
  const out = (r.stdout || '') + (r.stderr || '')
  // Parse TAP summary.
  const passM = out.match(/^# pass (\d+)/m)
  const failM = out.match(/^# fail (\d+)/m)
  const testsM = out.match(/^# tests (\d+)/m)
  const passes = passM ? parseInt(passM[1], 10) : null
  const fails = failM ? parseInt(failM[1], 10) : null
  const total = testsM ? parseInt(testsM[1], 10) : null

  if (passes === null && total === null) {
    return fail(id, `could not parse node --test output (exit ${r.status}). ${truncate(out)}`)
  }
  if (r.status !== 0 || (fails !== null && fails > 0)) {
    return fail(id, `node --test had failures (exit ${r.status}, fail=${fails ?? '?'} of ${total ?? '?'})`)
  }
  const counted = passes ?? total
  if (counted < 4) {
    return fail(id, `only ${counted} test(s) ran/passed; need >= 4 covering computeNextDue/filtering/snooze`)
  }
  pass(id, `node --test ran ${counted} passing test(s) (>= 4) for pure store ops`)
}

function discoverTestFiles(repo) {
  const found = []
  const tryAdd = p => { if (existsSync(p)) found.push(p) }
  // Conventional roots.
  for (const name of readdirSync(repo)) {
    if (/\.(test|spec)\.m?js$/.test(name)) found.push(join(repo, name))
  }
  for (const dir of ['test', 'tests', '__tests__']) {
    const d = join(repo, dir)
    if (existsSync(d)) {
      for (const name of readdirSync(d)) {
        if (/\.m?js$/.test(name)) found.push(join(d, name))
      }
    }
  }
  return [...new Set(found)]
}

// ─── misc utilities ───────────────────────────────────────────────────────────
function makeOsascriptStub() {
  // A fake `osascript` that exits 0 and does nothing, so the daemon's notification
  // path completes without firing a real macOS notification.
  const dir = freshHome()
  const stub = join(dir, 'osascript')
  writeFileSync(stub, '#!/bin/sh\nexit 0\n')
  chmodSync(stub, 0o755)
  return dir
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function truncate(s, n = 400) { s = (s || '').trim(); return s.length > n ? s.slice(0, n) + '…' : s }

// ─── main ─────────────────────────────────────────────────────────────────────
function main() {
  // Sanity: project files present.
  if (!existsSync(TODO)) {
    console.log(`FAIL C0: todo.js not found at ${TODO}`)
    console.log('RESULT: 0/1 passed')
    process.exit(1)
  }

  checkIsolation()
  if (!ISOLATION_OK) {
    console.log(`NOTE: isolation guard failed — ${ISOLATION_REASON}`)
    console.log('NOTE: store-dependent criteria (C2–C7) will FAIL; the real ~/.tenacious-todo is left untouched.')
  }

  c1()
  c2()
  c3()
  c4()
  c5()
  c6()
  c7()
  c8()
  c9()

  const total = results.length
  const passed = results.filter(r => r.ok).length
  console.log(`RESULT: ${passed}/${total} passed`)
  process.exit(passed === total ? 0 : 1)
}

main()
