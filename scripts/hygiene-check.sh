#!/usr/bin/env bash
# Blocks secrets, private ids, local paths and private terms from entering the repo.
#
#   bash scripts/hygiene-check.sh            every tracked and untracked (not ignored) file
#   bash scripts/hygiene-check.sh --staged   the STAGED content of staged files (pre-commit)
#
# This file is public, so it holds only generic patterns. Private terms (client names,
# real account ids, personal emails) live in a list outside the repo, one extended regex
# per line: $HYGIENE_PRIVATE_LIST, default ~/.config/perfoads-mcp-dev/hygiene-private.txt.
# Without that list the generic checks still run and a warning is printed.
#
# Patterns are written so this file does not match itself (e.g. "[s]" instead of "s").
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

PATTERNS=(
  'sk-an[t]-'
  'sk-pro[j]-'
  'sk_liv[e]'
  'passwor[d]='
  'GOCSP[X]-'
  'whse[c]_'
  'AKI[A][0-9A-Z]{16}'
  '-----BEGIN [A-Z ]*PRIVATE KE[Y]-----'
  'developer[-_]token["'"'"' ]*[:=][ "'"'"']*[A-Za-z0-9_-]{16,}'
  '/User[s]/'
  'onrender[.]com'
  'supabase[.]co'
  # internal ticket tags in comments: a comment marker, then F + 1-3 digits + ":" or ")"
  '(//|/\*|^[[:space:]]*\*|^[[:space:]]*#).*(^|[^[:alnum:]_])\(?F[0-9]{1,3}(:|\))'
  # references to private repo commits: the word commit, or perfoads@ / perfoads#, then a hash
  'commit[[:space:]:#]+[0-9a-f]{7,40}([^[:alnum:]]|$)'
  'perfoads[^[:space:]]*[@#][0-9a-f]{7,40}([^[:alnum:]]|$)'
)

# Google Ads customer ids: any run of exactly 10 digits (or the 3-3-4 dashed form), even
# glued to letters or "_" (customer_id_...), fails unless it is obviously fake:
# one repeated digit or a plain sequence. Real-looking ids in fixtures fail on purpose.
FAKE_IDS='^(0{10}|1{10}|2{10}|3{10}|4{10}|5{10}|6{10}|7{10}|8{10}|9{10}|1234567890|0123456789|9876543210)$'
real_looking_ids() {
  perl -ne 'while (/(?<![0-9])([0-9]{10}|[0-9]{3}-[0-9]{3}-[0-9]{4})(?![0-9])/g) { print "$.:$1\n" }' "$1" |
    while IFS=: read -r line id; do
      digits="${id//-/}"
      if [[ ! "$digits" =~ $FAKE_IDS ]]; then echo "$line"; fi
    done
}

PRIVATE_LIST="${HYGIENE_PRIVATE_LIST:-$HOME/.config/perfoads-mcp-dev/hygiene-private.txt}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PRIVATE_PATTERNS="$WORK/private-patterns"
if [[ -f "$PRIVATE_LIST" ]]; then
  grep -vE '^[[:space:]]*(#|$)' "$PRIVATE_LIST" >"$PRIVATE_PATTERNS" || true
else
  : >"$PRIVATE_PATTERNS"
  echo "hygiene: WARNING private list not found ($PRIVATE_LIST)." >&2
  echo "hygiene: client names and private ids are NOT checked; generic checks only." >&2
fi

list_files() {
  if [[ "${1:-}" == "--staged" ]]; then
    git -c core.quotePath=off diff --cached --name-only --diff-filter=ACMR -z
  else
    git -c core.quotePath=off ls-files -z
    git -c core.quotePath=off ls-files -z --others --exclude-standard
  fi
}

STAGED_COPY="$WORK/staged"
fail=0
report() { # file, reason, line numbers (content is never printed, it may be a secret)
  echo "hygiene: $2 in $1 (line $(echo "$3" | head -3 | paste -s -d, -))" >&2
  fail=1
}

while IFS= read -r -d '' f; do
  if [[ -z "$f" || "$f" == node_modules/* || "$f" == */node_modules/* ]]; then continue; fi
  if [[ "${1:-}" == "--staged" ]]; then
    git show ":$f" >"$STAGED_COPY" 2>/dev/null || continue
    src="$STAGED_COPY"
  else
    [[ -f "$f" ]] || continue
    src="$f"
  fi
  grep -qI . "$src" 2>/dev/null || continue # binary or empty

  for p in "${PATTERNS[@]}"; do
    hits=$(grep -nIiE -- "$p" "$src" 2>/dev/null | cut -d: -f1 || true)
    if [[ -n "$hits" ]]; then report "$f" "pattern '$p'" "$hits"; fi
  done
  if [[ -s "$PRIVATE_PATTERNS" ]]; then
    hits=$(grep -nIiE -f "$PRIVATE_PATTERNS" -- "$src" 2>/dev/null | cut -d: -f1 || true)
    if [[ -n "$hits" ]]; then report "$f" "private term (see $PRIVATE_LIST)" "$hits"; fi
  fi
  hits=$(real_looking_ids "$src")
  if [[ -n "$hits" ]]; then
    report "$f" "real-looking 10-digit customer id (use 1234567890 or one repeated digit)" "$hits"
  fi
  # Every TypeScript source file carries the license header in its first lines.
  if [[ "$f" == packages/*/src/*.ts ]] && ! head -5 "$src" | grep -q 'SPDX-License-Identifier: Apache-2[.]0'; then
    echo "hygiene: $f has no SPDX-License-Identifier: Apache-2.0 header in its first 5 lines" >&2
    fail=1
  fi
done < <(list_files "${1:-}")

# Every publishable package (no "private": true) ships copies of the root LICENSE and NOTICE
# in its npm tarball: they must exist and match the root files (--staged: the staged copies).
read_copy() {
  if [[ "${1:-}" == "--staged" ]]; then git show ":$2" 2>/dev/null; else cat -- "$2" 2>/dev/null; fi
}
has_copy() {
  if [[ "${1:-}" == "--staged" ]]; then git cat-file -e ":$2" 2>/dev/null; else [[ -f "$2" ]]; fi
}
for pj in packages/*/package.json; do
  has_copy "${1:-}" "$pj" || continue
  if read_copy "${1:-}" "$pj" | grep -qE '"private"[[:space:]]*:[[:space:]]*true'; then continue; fi
  dir="${pj%/package.json}"
  for name in LICENSE NOTICE; do
    if ! has_copy "${1:-}" "$dir/$name"; then
      echo "hygiene: $dir/$name is missing; copy the root $name (npm tarballs ship it)" >&2
      fail=1
    elif ! cmp -s <(read_copy "${1:-}" "$dir/$name") <(read_copy "${1:-}" "$name"); then
      echo "hygiene: $dir/$name differs from the root $name; copy the root file" >&2
      fail=1
    fi
  done
done

# Source and scripts must never be git-ignored: an over-broad .gitignore rule would
# silently leave a file out of every commit (and out of the scan above).
while IFS= read -r -d '' f; do
  echo "hygiene: $f is ignored by .gitignore but is source; narrow the ignore rule" >&2
  fail=1
done < <(git -c core.quotePath=off ls-files -z --others --ignored --exclude-standard -- \
  ':(glob)packages/*/src/**' ':(glob)scripts/**')

if [[ $fail -ne 0 ]]; then
  echo "hygiene check FAILED" >&2
  exit 1
fi
echo "hygiene check passed"
