#!/bin/bash
# Gets the latest version from GitHub, installs dependencies, and restarts the background service
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_macos
cd "$APP_DIR"

say_step "Downloading the latest version"
git pull --ff-only || die "Could not update automatically (local changes or a rewritten branch). See the README's Updating section."

say_step "Installing dependencies"
npm install --no-audit --no-fund

if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  say_step "Restarting"
  bash "$APP_DIR/scripts/mac/restart.sh"
else
  echo "Updated. Start it with: npm start   (or run npm run setup once to start it automatically)"
fi
