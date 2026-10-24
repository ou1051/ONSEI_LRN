#!/bin/bash
# Removes the background service and the ONSEI_LRN app. Your decks and cards (data/) are kept.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_macos

launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
rm -f "$PLIST"
rm -rf "$LAUNCHER"

echo "Removed the background service and ${LAUNCHER}."
echo "Your data is still in ${APP_DIR}/data"
