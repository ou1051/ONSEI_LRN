#!/bin/bash
# Restarts the background service (e.g. after an update)
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_macos

if ! launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  die "The background service is not installed. Run: npm run setup"
fi
launchctl kickstart -k "${DOMAIN}/${LABEL}"
if wait_for_server; then
  echo "Restarted. Running at $URL"
else
  say_warn "The server did not respond. Check the log with: npm run logs"
  exit 1
fi
