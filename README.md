# tenacious-todo

A to-do app that won't let go: escalating native macOS notifications nag you about overdue tasks until they're actually done.

## What it does

- Manage tasks with optional deadlines and priorities from your terminal
- Fires native macOS notifications (with Glass sound) for overdue tasks
- **Escalating nag schedule:** the longer a task is overdue, the more frequently it pesters you
  - < 1 hour overdue → nag every 30 minutes
  - 1–4 hours overdue → nag every 15 minutes
  - > 4 hours overdue → nag every 5 minutes
- Runs as a background daemon (via launchd) that starts at login
- Zero dependencies — pure Node.js 23 stdlib + macOS `osascript`

## Quickstart

```bash
# Clone the repo
git clone https://github.com/Alchemist-X/tenacious-todo.git
cd tenacious-todo

# Add a task
node todo.js add "File quarterly taxes" --due "2026-06-08 17:00" --priority high

# Add a task without a deadline
node todo.js add "Buy groceries" --priority low

# List all pending tasks
node todo.js list

# Mark a task done (use the ID shown in list)
node todo.js done <id>

# Remove a task
node todo.js rm <id>

# Fire all due notifications once (useful for testing)
node daemon.js --once

# Run the daemon in the foreground (polls every 60s)
node daemon.js
```

## How the nagging works

The daemon (`daemon.js`) polls your task store every 60 seconds. For each incomplete task whose deadline has passed, it:

1. Calculates how overdue the task is
2. Looks up the escalation tier to determine the minimum nag interval
3. Checks when it last notified you about that task
4. If enough time has passed, fires a native macOS notification via:
   ```
   osascript -e 'display notification "..." with title "Tenacious Todo" sound name "Glass"'
   ```
5. Records the notification timestamp (immutably in `~/.tenacious-todo/tasks.json`)

The `--once` flag skips the polling loop — it evaluates everything, fires due notifications, then exits. Useful for cron or manual testing.

## Install the background daemon

Run the installer script to register the daemon as a launchd agent (starts at login, restarts automatically if it crashes):

```bash
bash install-daemon.sh
```

This writes `~/Library/LaunchAgents/com.alchemist.tenacious-todo.plist` and loads it immediately.

**Useful follow-up commands:**
```bash
# Check it's running
launchctl list | grep tenacious

# Follow live logs
tail -f ~/.tenacious-todo/daemon.log

# Stop and disable
launchctl unload ~/Library/LaunchAgents/com.alchemist.tenacious-todo.plist

# Re-enable
launchctl load ~/Library/LaunchAgents/com.alchemist.tenacious-todo.plist
```

## Storage

All data lives in `~/.tenacious-todo/tasks.json`. The file is plain JSON — you can inspect or back it up freely.

## Requirements

- macOS (uses `osascript` for notifications)
- Node.js 23+ (uses ES modules; no `node_modules` needed)

## Limitations

- **macOS only** — notifications use `osascript`; the daemon install uses launchd. Linux/Windows not supported.
- **No network sync** — tasks live in a local JSON file only.
- **Single machine** — no multi-device or collaboration support.
- **Notifications require macOS permission** — on first run, macOS may ask you to allow Terminal (or the app running node) to send notifications. Grant it in System Settings → Notifications.
- **No recurring tasks** — each task is one-shot.
- **No snooze** — mark a task done to silence it.

## License

MIT © 2026 Alchemist-X
