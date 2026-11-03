#!/usr/bin/env bash
# Proves scripts/hygiene-check.sh catches what it should and allows what it should,
# each case in a throwaway git repo. Run: bash scripts/hygiene-selftest.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/scripts/hygiene-check.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Built from pieces so this file itself holds no real-looking id or private term.
REAL_ID="58""39201746"
REAL_DASHED="583-""920-1746"
PRIVATE_TERM="Zebra""quill Widgets"
printf '# test list\n\nzebraquill[[:space:]]+widgets\n' >"$WORK/private.txt"
export HYGIENE_PRIVATE_LIST="$WORK/private.txt"

passed=0
failed=0
n=0

new_repo() {
  n=$((n + 1))
  REPO="$WORK/repo$n"
  mkdir -p "$REPO/scripts"
  cp "$CHECK" "$REPO/scripts/hygiene-check.sh"
  git -C "$REPO" init -q
  git -C "$REPO" add scripts/hygiene-check.sh
}

run_check() { (cd "$REPO" && bash scripts/hygiene-check.sh "$@" 2>&1); }

expect() { # expect pass|fail "name" [--staged] [output must contain]
  local want="$1" name="$2" mode="${3:-}" needle="${4:-}" out status
  if out=$(run_check $mode); then status=pass; else status=fail; fi
  if [[ "$status" == "$want" && (-z "$needle" || "$out" == *"$needle"*) ]]; then
    echo "ok   - $name"
    passed=$((passed + 1))
  else
    echo "FAIL - $name (wanted $want${needle:+ with \"$needle\"}, got $status)"
    echo "$out" | sed 's/^/       /'
    failed=$((failed + 1))
  fi
}

new_repo
mkdir -p "$REPO/fixtures"
printf 'const id = "%s";\n' "$REAL_ID" >"$REPO/fixtures/café-ü.ts"
expect fail "untracked file with a unicode name is scanned" "" "café-ü.ts"
git -C "$REPO" add -A
expect fail "tracked file with a unicode name is scanned" "" "café-ü.ts"

new_repo
printf 'const a = "customer_id_%s";\n' "$REAL_ID" >"$REPO/a.ts"
expect fail "id glued to a prefix (customer_id_...) is caught"
printf 'const a = "acct.%s-x";\nconst b = "v%s";\n' "$REAL_ID" "$REAL_ID" >"$REPO/a.ts"
expect fail "id after a dot or a letter is caught"
printf 'phone = "%s"\n' "$REAL_DASHED" >"$REPO/a.ts"
expect fail "dashed id is caught"

new_repo
printf 'const id = "%s";\n' "$REAL_ID" >"$REPO/staged.ts"
git -C "$REPO" add staged.ts
printf 'const id = "1234567890";\n' >"$REPO/staged.ts"
expect fail "--staged scans the staged content, not the clean working copy" --staged "staged.ts"
expect pass "full scan reads the working copy"
git -C "$REPO" add staged.ts
printf 'const id = "%s";\n' "$REAL_ID" >"$REPO/staged.ts"
expect pass "--staged ignores an unstaged bad edit" --staged

new_repo
cat >"$REPO/fake.ts" <<'EOF'
const ids = ["1234567890", "1111111111", "2222222222", "9876543210", "123-456-7890"];
const prefixed = "customer_id_1234567890";
const notIds = [123456789, 12345678901, 9007199254740993n, "2026-10-24"];
EOF
expect pass "obviously fake ids and non-id numbers are allowed"

new_repo
printf '\x00\x01binary %s\x00' "$REAL_ID" >"$REPO/blob.bin"
expect pass "binary files are skipped"

new_repo
printf 'made for %s\n' "$PRIVATE_TERM" >"$REPO/notes.md"
expect fail "term from the private list is caught" "" "private term"
HYGIENE_PRIVATE_LIST="$WORK/missing.txt" expect pass "missing private list: warns, generic checks still run" "" "WARNING"

new_repo
printf '%s\n' '// F''12: fix the thing' >"$REPO/c.ts"
expect fail "internal F-tag in a comment is caught"
printf '%s\n' 'const color = 0xF1; // keep' >"$REPO/c.ts"
expect pass "hex values are not F-tags"

new_repo
mkdir -p "$REPO/packages/demo/src"
printf '// SPDX-License-Identifier: Apache-2.0\nexport const x = 1;\n' >"$REPO/packages/demo/src/secrets-store.ts"
printf 'secrets*\n' >"$REPO/.gitignore"
expect fail "git-ignored source file is caught" "" "packages/demo/src/secrets-store.ts"
printf '/secrets*\n' >"$REPO/.gitignore"
expect pass "a narrowed ignore rule lets the source file through"

new_repo
expect pass "the check script passes on itself (no self-skip needed)"

new_repo
mkdir -p "$REPO/packages/demo/src/deep"
printf 'export const x = 1;\n' >"$REPO/packages/demo/src/deep/no-header.ts"
expect fail "a .ts source file without the SPDX header is caught" "" "no-header.ts"
printf '// SPDX-License-Identifier: Apache-2.0\n// Copyright 2026 The authors\n\nexport const x = 1;\n' >"$REPO/packages/demo/src/deep/no-header.ts"
expect pass "a .ts source file with the SPDX header passes"
printf '// SPDX-License-Identifier: FSL-1.1-ALv2\n// Copyright 2026 The authors\n\nexport const x = 1;\n' >"$REPO/packages/demo/src/deep/no-header.ts"
expect fail "a .ts source file with the old FSL header is caught" "" "no-header.ts"

new_repo
printf 'root license\n' >"$REPO/LICENSE"
printf 'root notice\n' >"$REPO/NOTICE"
mkdir -p "$REPO/packages/demo" "$REPO/packages/internal"
printf '{ "name": "demo" }\n' >"$REPO/packages/demo/package.json"
printf '{ "name": "internal", "private": true }\n' >"$REPO/packages/internal/package.json"
printf 'old license\n' >"$REPO/packages/demo/LICENSE"
cp "$REPO/NOTICE" "$REPO/packages/demo/NOTICE"
expect fail "a package LICENSE that differs from the root one is caught" "" "packages/demo/LICENSE differs"
cp "$REPO/LICENSE" "$REPO/packages/demo/LICENSE"
expect pass "package copies equal to the root ones pass; a private package needs none"
rm "$REPO/packages/demo/NOTICE"
expect fail "a publishable package without NOTICE is caught" "" "packages/demo/NOTICE is missing"
cp "$REPO/NOTICE" "$REPO/packages/demo/NOTICE"
git -C "$REPO" add -A
printf 'edited notice\n' >"$REPO/packages/demo/NOTICE"
expect pass "--staged compares the staged copies (an unstaged edit is not checked)" --staged
git -C "$REPO" add -A
expect fail "--staged catches a staged copy that differs" --staged "packages/demo/NOTICE differs"

echo "hygiene self-test: $passed passed, $failed failed"
[[ $failed -eq 0 ]]
