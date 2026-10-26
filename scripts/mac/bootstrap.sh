#!/bin/bash
# One-line install for macOS:
#   curl -fsSL https://raw.githubusercontent.com/ou1051/ONSEI_LRN/feature/onsei-lrn-app/scripts/mac/bootstrap.sh | bash
#
# Downloads (or updates) ONSEI_LRN into ~/ONSEI_LRN, installs what it needs, and sets it up to
# run in the background. Afterwards the app is just a bookmark: http://localhost:3000
# Safe to run again at any time (it updates instead of reinstalling). Your data is kept.
set -euo pipefail

REPO_URL="${ONSEI_REPO_URL:-https://github.com/ou1051/ONSEI_LRN.git}"
BRANCH="${ONSEI_BRANCH:-feature/onsei-lrn-app}"
DIR="${ONSEI_DIR:-$HOME/ONSEI_LRN}"

bold() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS."

# Homebrew and nvm installs are often not on PATH in a non-interactive shell
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# shellcheck source=/dev/null
if [ -s "$HOME/.nvm/nvm.sh" ]; then set +u; . "$HOME/.nvm/nvm.sh"; set -u; fi

bold "Checking git"
if ! xcode-select -p >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
  xcode-select --install >/dev/null 2>&1 || true
  die "git is needed. A window to install Apple's Command Line Tools should have opened; finish it, then run this command again."
fi

bold "Checking Node.js"
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if ! node_ok; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js with Homebrew…"
    brew install node
  fi
  node_ok || die "Node.js 20 or newer is needed. Install the LTS version from https://nodejs.org, then run this command again."
fi
echo "Node.js $(node -v)"

bold "Getting ONSEI_LRN"
if [ -d "$DIR/.git" ]; then
  cd "$DIR"
  git fetch origin "$BRANCH"
  git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" "origin/$BRANCH"
  if ! git pull -q --rebase --autostash origin "$BRANCH"; then
    git rebase --abort >/dev/null 2>&1 || true
    # Your data (data/) is not tracked by git, so this is safe
    echo "Local copy could not be updated cleanly; resetting it to the latest version."
    git reset -q --hard "origin/$BRANCH"
  fi
elif [ -e "$DIR" ]; then
  die "$DIR already exists and is not a git checkout. Move it away (or set ONSEI_DIR) and run this again."
else
  git clone -q -b "$BRANCH" "$REPO_URL" "$DIR"
  cd "$DIR"
fi
echo "In $DIR ($(git log -1 --format='%h %s'))"

bold "Checking Claude Code"
if ! command -v claude >/dev/null 2>&1; then
  echo "Installing Claude Code…"
  if ! npm install -g @anthropic-ai/claude-code; then
    die "Could not install Claude Code. Run: npm install -g @anthropic-ai/claude-code (with sudo if needed), then run this command again."
  fi
fi
echo "Claude Code $(claude --version 2>/dev/null || echo installed)"

bash "$DIR/scripts/mac/install.sh"

cat <<EOF

All set. Bookmark this and open it any time:  http://localhost:3000
If you have not logged in to Claude Code yet: open Terminal, run  claude , log in with your
Claude Pro/Max account, then type /exit.
If adding a PDF then says "not logged in" or shows an authentication error, open
Settings → Claude connection in the app and follow the steps there (claude setup-token).
EOF
