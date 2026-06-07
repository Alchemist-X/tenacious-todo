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
- Zero dependencies — pure Node.js 23 stdlib + macOS `osascript`
- Runs as a background daemon (via launchd) that starts at login

## Quickstart

```bash
# Clone the repo
git clone https://github.com/Alchemist-X/tenacious-todo.git
cd tenacious-todo

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
  --repeat daily|weekly|weekdays|"every 3d"
  --tag <name>                     Repeat for multiple tags: --tag work --tag urgent
  --note "<text>"                  A single short note shown below the task

node todo.js list
  --tag <name>                     Filter by tag
  --overdue                        Only overdue tasks
  --today                          Only tasks due today
  --done                           Only completed tasks
  --all                            Pending + done together

node todo.js snooze <id> <delay>
  30m  2h  tomorrow  "YYYY-MM-DD HH:MM"
```

## Repeat schedules

| Value | Meaning |
|-------|---------|
| `daily` | Every 24 hours |
| `weekly` | Every 7 days |
| `weekdays` | Mon–Fri, skipping weekends |
| `every 3d` | Every 3 days |
| `every 2w` | Every 2 weeks |
| `every 4h` | Every 4 hours |

When you mark a recurring task `done`, the next occurrence is created automatically with the same text, priority, tags, and note.

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

## Requirements

- macOS (uses `osascript` for notifications; launchd for the background agent)
- Node.js 23+ (ES modules, no `node_modules` needed)

## Limitations

- **macOS only** — notifications use `osascript`; the daemon install uses launchd.
- **No network sync** — tasks live in a local JSON file only.
- **Notifications require macOS permission** — on first run, macOS may ask you to allow Terminal (or the app running node) to send notifications. Grant it in System Settings → Notifications.

## License

MIT © 2026 Alchemist-X
