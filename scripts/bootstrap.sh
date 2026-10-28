#!/usr/bin/env bash
# Bootstraps kibanaut on a Mac: switches gh to the right account, extracts the
# tarball into ~/Repositories, makes the first commit, and creates the GitHub repo.
#
#   bash bootstrap.sh Kibanaut-0.1.0.tar.gz
#
# Override with env vars: GH_USER, DEST, VISIBILITY (--private|--public), REPO_NAME.
set -euo pipefail

TARBALL="${1:-Kibanaut-0.1.0.tar.gz}"
GH_USER="${GH_USER:-albertkhoury-elasticgov}"
REPO_NAME="${REPO_NAME:-Kibanaut}"
DEST="${DEST:-$HOME/Repositories/$REPO_NAME}"
VISIBILITY="${VISIBILITY:---private}"

say() { printf '\033[38;2;0;191;179m▍\033[0m %s\n' "$*"; }
die() { printf '\033[38;2;240;78;152m▍\033[0m %s\n' "$*" >&2; exit 1; }

command -v gh >/dev/null || die "GitHub CLI (gh) is required: brew install gh"
command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "Node 22+ is required: brew install node"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die "Node 22+ is required (found $(node -v))"
[ -f "$TARBALL" ] || die "Tarball not found: $TARBALL"
[ ! -e "$DEST" ] || die "$DEST already exists; remove it or set DEST"

say "Making $GH_USER the active GitHub account"
if gh auth status 2>&1 | grep -q "$GH_USER"; then
  gh auth switch --user "$GH_USER" 2>/dev/null || true
else
  say "$GH_USER is not logged in yet; opening gh auth login"
  gh auth login --hostname github.com --git-protocol https --web
  gh auth switch --user "$GH_USER" 2>/dev/null || true
fi
gh auth status 2>&1 | grep -A2 "$GH_USER" | head -3 || die "Could not activate $GH_USER"

say "Extracting into $DEST"
mkdir -p "$(dirname "$DEST")"
tmp="$(mktemp -d)"
tar -xzf "$TARBALL" -C "$tmp"
mv "$tmp"/Kibanaut "$DEST"
rmdir "$tmp"
cd "$DEST"

say "Installing dependencies, building, and running the tests"
npm install
npm run build
npm test

say "Creating the first commit"
git init -b main >/dev/null
git add -A
git -c user.useConfigOnly=false commit -q -m "kibanaut: ES|QL mission-control TUI with lint and completion"

say "Creating github.com/$GH_USER/$REPO_NAME ($VISIBILITY)"
gh repo create "$GH_USER/$REPO_NAME" $VISIBILITY --source=. --remote=origin --push \
  --description "Pilot Kibana from a mission-control TUI: ES|QL with linting and completion built in."

if [ "${LINK:-1}" = "1" ]; then
  say "Linking the kibanaut and kq commands onto your PATH (npm link)"
  npm link >/dev/null 2>&1 || say "npm link needs permissions; run it manually or use: node $DEST/dist/cli.js"
fi

say "Done. Next: run 'kibanaut' for first-run setup, or 'kibanaut --demo' to try it without a cluster."
gh repo view "$GH_USER/$REPO_NAME" --web >/dev/null 2>&1 || true
