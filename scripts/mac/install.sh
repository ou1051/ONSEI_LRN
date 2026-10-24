#!/bin/bash
# One-time setup on macOS:
#  - runs ONSEI_LRN in the background, starting automatically when you log in
#  - adds an "ONSEI_LRN" app (Spotlight / Launchpad / Dock) that opens it in Chrome
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_macos
cd "$APP_DIR"

say_step "Checking Node.js"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "Node.js was not found. Install it from https://nodejs.org and run this again."
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20 or newer is required (found $("$NODE_BIN" -v)). Update it from https://nodejs.org"
echo "Using $NODE_BIN ($("$NODE_BIN" -v))"

say_step "Checking Claude Code"
CLAUDE_BIN="$(command -v claude || true)"
if [ -n "$CLAUDE_BIN" ]; then
  echo "Using $CLAUDE_BIN"
else
  say_warn "Claude Code was not found. The app will start, but checking explanations needs it:"
  echo "    npm install -g @anthropic-ai/claude-code"
  echo "    claude      (log in once, then type /exit)"
  echo "  Then run: npm run setup"
fi

say_step "Installing dependencies"
npm install --no-audit --no-fund

# A copy started with `npm start` would hold the port and block the background service
if curl -fsS "${URL}/api/health" >/dev/null 2>&1 && ! launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  die "ONSEI_LRN is already running in a terminal. Stop it there with Ctrl+C, then run this again."
fi

say_step "Registering the background service"
# PATH for the service: the current one (so `claude` and `node` are found), minus npm's temporary entries
SERVICE_PATH="$(printf '%s\n' "$PATH" | tr ':' '\n' | awk 'length($0) && index($0, "node_modules/.bin") == 0 && index($0, "node-gyp-bin") == 0 && !seen[$0]++' | paste -sd ':' -)"
SERVICE_PATH="${SERVICE_PATH}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

CLAUDE_ENV=""
if [ -n "$CLAUDE_BIN" ]; then
  CLAUDE_ENV="    <key>ONSEI_CLAUDE_BIN</key><string>$(xml "$CLAUDE_BIN")</string>"
fi

mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE_BIN")</string>
    <string>$(xml "$APP_DIR/server.js")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$APP_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$SERVICE_PATH")</string>
    <key>PORT</key><string>${PORT}</string>
${CLAUDE_ENV}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml "$LOG_DIR/server.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG_DIR/server.log")</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null || die "The service file is invalid: $PLIST"

launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
# Right after a bootout, bootstrap can fail briefly ("Input/output error"); retry a few times
tries=0
until launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -lt 5 ] || die "Could not register the background service. Try: npm run setup again, or restart your Mac."
  sleep 1
done

if wait_for_server; then
  echo "Running at $URL"
else
  say_warn "The server did not respond yet. Recent log output:"
  tail -n 20 "$LOG_DIR/server.log" 2>/dev/null || true
fi

say_step "Creating the ${APP_NAME} app"
mkdir -p "$(dirname "$LAUNCHER")"
TMP_DIR="$(mktemp -d)"
SCRIPT_FILE="$TMP_DIR/launcher.applescript"
cat > "$SCRIPT_FILE" <<EOF
-- Starts the background service if needed, then opens ONSEI_LRN in the browser
do shell script "launchctl kickstart ${DOMAIN}/${LABEL} >/dev/null 2>&1 || true; i=0; while [ \$i -lt 20 ]; do curl -fsS ${URL}/api/health >/dev/null 2>&1 && break; sleep 0.5; i=\$((i+1)); done; open -a 'Google Chrome' '${URL}' 2>/dev/null || open '${URL}'"
EOF
rm -rf "$LAUNCHER"
if osacompile -o "$LAUNCHER" "$SCRIPT_FILE"; then
  echo "Created $LAUNCHER"
else
  say_warn "Could not create the app. You can still open $URL in your browser."
fi
rm -rf "$TMP_DIR"

say_step "Done"
cat <<EOF
ONSEI_LRN now runs in the background and starts automatically when you log in.
To open it: press Cmd+Space, type "ONSEI", and press Return
            (or drag ~/Applications/${APP_NAME}.app to your Dock, or bookmark ${URL}).

Other commands (run in this folder):
  npm run update     get the latest version and restart
  npm run restart    restart the background service
  npm run logs       show the server log
  npm run uninstall  remove the background service and the app (your data is kept)
EOF

open_app
