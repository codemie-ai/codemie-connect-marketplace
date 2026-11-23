#!/usr/bin/env bash
# Quality gate for this marketplace: syntax-checks every plugin and test script, then runs the
# unit tests. Exits 1 on any failure (macOS/zsh-compatible; no GNU-only flags).
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root" || exit 1

status=0

while IFS= read -r -d '' f; do
  if ! node --check "$f"; then
    echo "syntax error: $f" >&2
    status=1
  fi
done < <(find plugins tests -type f \( -name '*.js' -o -name '*.mjs' \) -print0)

if ! node --test 'tests/**/*.test.mjs'; then
  status=1
fi

exit "$status"
