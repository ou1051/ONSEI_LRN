#!/bin/bash
# Gets the latest version from GitHub, installs dependencies, and restarts the background service
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_macos
cd "$APP_DIR"

say_step "Downloading the latest version"
# --rebase keeps any local commits (e.g. your progress log) on top of the new version
if ! git pull --rebase --autostash; then
  git rebase --abort >/dev/null 2>&1 || true
  die "Could not update automatically. Run the installer again to reset to the latest version (your data is kept):
  curl -fsSL https://raw.githubusercontent.com/ou1051/ONSEI_LRN/feature/onsei-lrn-app/scripts/mac/bootstrap.sh | bash"
fi

say_step "Installing dependencies"
npm install --no-audit --no-fund

if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  say_step "Restarting"
  bash "$APP_DIR/scripts/mac/restart.sh"
else
  echo "Updated. Start it with: npm start   (or run npm run setup once to start it automatically)"
fi
