#!/usr/bin/env bash
# install-daemon.sh — install tenacious-todo as a launchd background agent
# Runs on macOS only. Starts the daemon at login.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_LABEL="com.alchemist.tenacious-todo"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_DIR="$HOME/.tenacious-todo"
LOG_OUT="${LOG_DIR}/daemon.log"
LOG_ERR="${LOG_DIR}/daemon.err"

NODE_PATH="$(command -v node || true)"
if [[ -z "$NODE_PATH" ]]; then
  echo "ERROR: node not found in PATH. Install Node.js 23+ first."
  exit 1
fi

mkdir -p "$LOG_DIR"

echo "Installing launchd agent..."
echo "  Script dir : $SCRIPT_DIR"
echo "  Node path  : $NODE_PATH"
echo "  Plist      : $PLIST_PATH"
echo "  Log stdout : $LOG_OUT"
echo "  Log stderr : $LOG_ERR"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${SCRIPT_DIR}/daemon.js</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_OUT}</string>

  <key>StandardErrorPath</key>
  <string>${LOG_ERR}</string>

  <key>WorkingDirectory</key>
  <string>${SCRIPT_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
PLIST

# Unload if already loaded (ignore errors)
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo ""
echo "Daemon installed and started. ✅"
echo ""
echo "Useful commands:"
echo "  launchctl list | grep tenacious     — check it's running"
echo "  tail -f $LOG_OUT                    — follow daemon logs"
echo "  launchctl unload $PLIST_PATH        — stop and disable"
echo "  bash install-daemon.sh              — reinstall / update"
