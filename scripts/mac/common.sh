# Shared settings for the macOS scripts. Sourced, not run directly.
# Written for the bash 3.2 that ships with macOS.
# shellcheck disable=SC2034  # variables are used by the scripts that source this file

LABEL="com.onsei-lrn.server"
APP_NAME="ONSEI_LRN"
PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/${APP_NAME}"
LAUNCHER="$HOME/Applications/${APP_NAME}.app"
DOMAIN="gui/$(id -u)"

say_step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
say_warn() { printf '\033[33mWarning:\033[0m %s\n' "$1"; }
die() { printf '\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }

require_macos() {
  [ "$(uname -s)" = "Darwin" ] || die "This script is for macOS. On other systems, run: npm start"
}

# Waits until the server answers; returns non-zero after ~15 seconds
wait_for_server() {
  i=0
  while [ "$i" -lt 30 ]; do
    if curl -fsS "${URL}/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

# Chrome has the best speech recognition; fall back to the default browser
open_app() {
  open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
}
