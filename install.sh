#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo '需要 Node.js 20+（macOS 可用 brew install node）。' >&2
  exit 1
fi
node scripts/install.mjs
