#!/bin/bash
# Double-click in Finder to start ONSEI_LRN without installing the background service.
# Keep the Terminal window open while you use the app; close it to stop.
cd "$(dirname "$0")" || exit 1

# Double-clicked scripts may not get your usual PATH; add the common Node.js locations
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi

URL="http://localhost:${PORT:-3000}"
open_app() { open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"; }

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it from https://nodejs.org and try again."
  read -r -p "Press Return to close."
  exit 1
fi

# Already running (e.g. as the background service)? Just open it.
if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
  open_app
  exit 0
fi

[ -d node_modules ] || npm install --no-audit --no-fund || exit 1

# Open the browser once the server answers
(
  for _ in $(seq 1 30); do
    if curl -fsS "$URL/api/health" >/dev/null 2>&1; then open_app; exit 0; fi
    sleep 0.5
  done
) &

exec node server.js
