# tenacious-todo

A to-do app that won't let go: escalating native macOS notifications nag you about overdue tasks until they're actually done.

## What it does

- Manage tasks with optional deadlines, priorities, tags, notes, and repeat schedules
- Fires native macOS notifications for overdue tasks with escalating frequency
- **Recurring tasks:** completing a recurring task automatically schedules the next occurrence
- **Snooze:** defer a task's reminders by 30m, 2h, tomorrow, or any date
- **Tags + filtering:** tag tasks and filter `list` by tag, `--overdue`, `--today`, `--done`
- **Stats:** completion rate, per-priority counts, and a daily completion streak
- **Quick views:** `today` and `overdue` shortcut commands
- **Quiet hours:** no nag notifications between 23:00–08:00 (configurable in `~/.tenacious-todo/tasks.json`)
- **Morning summary:** daily "good morning" notification with pending/overdue count at 08:00
- **Polished CLI:** aligned box-drawing columns, priority/status color coding, relative due times ("in 2h", "3d overdue"), TTY-aware (no color when piped)
- **Scriptable:** `list --json` emits the (filtered) tasks as a JSON array for piping into `jq` and friends
- Zero dependencies — pure Node.js stdlib + macOS `osascript`
- Runs as a background daemon (via launchd) that starts at login
- Installable / runnable with `npx` (a `todo` bin is published in `package.json`)

## Quickstart

```bash
# Clone the repo
git clone https://github.com/Alchemist-X/tenacious-todo.git
cd tenacious-todo

# (Optional) run it as the `todo` bin without installing globally:
#   npx . --help
#   npx . add "Ship feature" --due "2026-06-10 17:00" --priority high
# or, once published to npm:  npx tenacious-todo --help
# The examples below use `node todo.js`; `todo` (the bin) is equivalent.

# Add tasks
node todo.js add "Ship feature" --due "2026-06-10 17:00" --priority high --tag work --note "Review PR first"
node todo.js add "Daily standup" --due "2026-06-07 09:00" --repeat weekdays --tag work
node todo.js add "Buy groceries" --priority low --tag personal

# List all pending tasks (colored, aligned table)
node todo.js list

# Filtered views
node todo.js list --overdue
node todo.js list --today
node todo.js list --tag work
node todo.js list --done
node todo.js list --all        # pending + done
node todo.js list --json       # machine-readable JSON array (respects filters)
node todo.js list --overdue --json | jq '.[].text'

# Quick view shortcuts
node todo.js today
node todo.js overdue

# Mark a task done (recurring tasks auto-schedule the next occurrence)
node todo.js done <id>

# Snooze reminders
node todo.js snooze <id> 30m
node todo.js snooze <id> 2h
node todo.js snooze <id> tomorrow

# Remove a task
node todo.js rm <id>

# Completion stats and streak
node todo.js stats

# Fire all due notifications once (useful for testing)
node daemon.js --once

# Run the daemon in the foreground (polls every 60s)
node daemon.js
```

## All command flags

```
node todo.js add "<text>"
  --due "YYYY-MM-DD HH:MM"        Optional deadline
  --priority high|med|low          Default: med
  --repeat daily|weekly|weekdays|monthly|yearly|"every 3d"
                                   Unsupported values are rejected at add-time
  --tag <name>                     Repeat for multiple tags: --tag work --tag urgent
  --note "<text>"                  A single short note shown below the task

node todo.js list
  --tag <name>                     Filter by tag
  --overdue                        Only overdue tasks
  --today                          Only tasks due today
  --done                           Only completed tasks
  --all                            Pending + done together
  --json                           Emit a JSON array instead of the table

node todo.js snooze <id> <delay>
  30m  2h  tomorrow  "YYYY-MM-DD HH:MM"
```

## Repeat schedules

| Value | Meaning |
|-------|---------|
| `daily` | Every 24 hours |
| `weekly` | Every 7 days |
| `weekdays` | Mon–Fri, skipping weekends |
| `monthly` | Same day next calendar month (clamped: Jan 31 → Feb 28/29) |
| `yearly` | Same date next year |
| `every 3d` | Every 3 days |
| `every 2w` | Every 2 weeks |
| `every 4h` | Every 4 hours |

When you mark a recurring task `done`, the next occurrence is created automatically with the same text, priority, tags, and note. Any `--repeat` value that isn't one of the above is **rejected at add-time** with a clear error, so a task can never be silently accepted with a schedule that would never reschedule.

## How the nagging works

The daemon (`daemon.js`) polls your task store every 60 seconds. For each incomplete, non-snoozed task whose deadline has passed:

1. Calculates how overdue the task is
2. Looks up the escalation tier to determine the minimum nag interval
3. Checks when it last notified you about that task
4. If enough time has passed and quiet hours are not active, fires a native macOS notification via `osascript`
5. Records the notification timestamp (immutably in `~/.tenacious-todo/tasks.json`)

**Escalation schedule:**
- < 1 hour overdue → nag every 30 minutes
- 1–4 hours overdue → nag every 15 minutes
- > 4 hours overdue → nag every 5 minutes

**Quiet hours:** No nag notifications between 23:00–08:00. Configurable in `~/.tenacious-todo/tasks.json` → `config.quietHoursStart` / `config.quietHoursEnd`.

**Morning summary:** At 08:00 each day, a single summary notification shows how many tasks are pending/overdue. Configurable via `config.morningHour`.

**Snooze:** A snoozed task is silenced in the daemon until the snooze expires, then resumes normal nagging.

## Install the background daemon

```bash
bash install-daemon.sh
```

This writes `~/Library/LaunchAgents/com.alchemist.tenacious-todo.plist` and loads it immediately.

**Useful follow-up commands:**
```bash
launchctl list | grep tenacious            # Check it's running
tail -f ~/.tenacious-todo/daemon.log       # Follow live logs
launchctl unload ~/Library/LaunchAgents/com.alchemist.tenacious-todo.plist  # Stop and disable
launchctl load  ~/Library/LaunchAgents/com.alchemist.tenacious-todo.plist   # Re-enable
bash install-daemon.sh                     # Reinstall / update
```

## Storage

All data lives in `~/.tenacious-todo/tasks.json`. The file is plain JSON — inspect or back it up freely.

```
~/.tenacious-todo/
  tasks.json     — tasks, lastNotified timestamps, and config
  daemon.log     — daemon stdout (after launchd install)
  daemon.err     — daemon stderr (after launchd install)
```

### Isolated store (`TENACIOUS_HOME`)

Set the `TENACIOUS_HOME` environment variable to point the store at a different
directory. When set (and non-empty), it **is** the data dir; otherwise the app
falls back to `~/.tenacious-todo`. Both `todo.js` and `daemon.js` honor it.

This is useful for scratch/throwaway stores and for testing without touching your
real data:

```bash
TENACIOUS_HOME=/tmp/ttodo-scratch node todo.js add "test" --due "2026-06-10 09:00"
TENACIOUS_HOME=/tmp/ttodo-scratch node todo.js list
TENACIOUS_HOME=/tmp/ttodo-scratch node daemon.js --once
```

## Tests

Pure store/filter/time logic (`computeNextDue`, the list filters, snooze math,
immutable mutations) is covered by Node's built-in test runner — no test deps:

```bash
node --test          # or: npm test
```

## Self-eval

A zero-dependency end-to-end eval harness lives under `eval/`. It runs every
store-touching check against a fresh isolated `TENACIOUS_HOME` temp dir, so it
never writes to your real store:

```bash
node eval/eval.mjs   # or: npm run eval
```

It prints `PASS C<N>` / `FAIL C<N>` per criterion and a final `RESULT: X/Y passed`
line, exiting `0` only when all criteria pass. See `eval/criteria.md` for the
human-readable criteria.

## Requirements

- macOS for notifications/daemon (uses `osascript`; launchd for the background agent). The CLI itself (`todo.js`) and the test suite run on any platform.
- Node.js 18+ (ES modules, built-in test runner; no `node_modules` needed)

## Limitations

- **macOS only** — notifications use `osascript`; the daemon install uses launchd.
- **No network sync** — tasks live in a local JSON file only.
- **Notifications require macOS permission** — on first run, macOS may ask you to allow Terminal (or the app running node) to send notifications. Grant it in System Settings → Notifications.

## License

MIT © 2026 Alchemist-X
