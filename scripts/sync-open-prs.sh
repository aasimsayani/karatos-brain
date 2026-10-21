#!/usr/bin/env bash
# Keep every open PR current with its base after a merge: scripts/sync-open-prs.sh
# Needs gh signed in with push access. Run from a clean checkout.
# - Merges the base in (never rebases, so no force-push).
# - CHANGELOG.md: a branch's own changelog lines move into changelog.d/<branch>.md and
#   CHANGELOG.md takes the base's version, so the file can't conflict again.
# - README.md: the generated progress block is regenerated after the merge, which also settles a conflict inside it.
# - Any other conflict is left for a person and reported.
# - Reinstalls dependencies after a merge, so the checks run against the merged lockfile.
# - Runs secrets:scan, typecheck, test:coverage (and changelog:check when present) before pushing.
set -u
cd "$(git rev-parse --show-toplevel)" && git fetch -q origin
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || gh api "repos/$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')" --jq .full_name)
G=git
for pr in $(gh api "repos/$REPO/pulls?state=open" --jq '.[]|.number' | sort -n); do
  br=$(gh api repos/$REPO/pulls/$pr --jq .head.ref); base=$(gh api repos/$REPO/pulls/$pr --jq .base.ref)
  # Release branches fold the fragments into CHANGELOG.md on purpose.
  case "$br" in release/*) echo "$pr skipped ($br)"; continue;; esac
  git checkout -q -B $br origin/$br
  mb=$(git merge-base origin/$base HEAD)
  frag="changelog.d/$(echo "$br" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9._-]+/-/g; s/^[^a-z0-9]+|-+$//g').md"
  # Lines this branch added to CHANGELOG.md that the base doesn't already carry.
  added=$(git diff -U0 $mb HEAD -- CHANGELOG.md | grep -E '^\+- ' | sed 's/^+//' | grep -vxF -f <(git show origin/$base:CHANGELOG.md) || true)
  uptodate=0; git merge-base --is-ancestor origin/$base HEAD && uptodate=1
  if [ $uptodate = 1 ] && git diff --quiet $mb HEAD -- CHANGELOG.md; then echo "$pr up to date"; continue; fi
  if [ $uptodate = 0 ] && ! $G merge -q --no-edit origin/$base >/dev/null 2>&1; then
    conflicted=$(git diff --name-only --diff-filter=U)
    others=$(echo "$conflicted" | grep -vxE 'CHANGELOG.md|README.md')
    if echo "$conflicted" | grep -qx README.md; then
      # Only the generated block may conflict; regenerating it removes those markers.
      { [ -f scripts/progress-cli.ts ] && npm run -s progress:write >/dev/null 2>&1 && ! grep -qE '^(<<<<<<<|=======|>>>>>>>)' README.md; } || others="$others README.md"
    fi
    if [ -n "$others" ]; then echo "$pr NEEDS HAND RESOLUTION: $others"; git merge --abort; continue; fi
    echo "$conflicted" | grep -qx CHANGELOG.md && git checkout -q origin/$base -- CHANGELOG.md
    git add -A README.md CHANGELOG.md
    $G commit -q --no-edit
  fi
  if [ -n "$added" ] || ! git diff --quiet origin/$base HEAD -- CHANGELOG.md; then
    mkdir -p changelog.d
    if [ -n "$added" ]; then { [ -f "$frag" ] && cat "$frag"; echo "$added"; } | awk '!seen[$0]++' > "$frag.tmp" && mv "$frag.tmp" "$frag"; fi
    git checkout -q origin/$base -- CHANGELOG.md
    git add -A changelog.d CHANGELOG.md
    $G commit -q -m "Move this PR's changelog entry to $frag"
  fi
  npm ci --silent >/dev/null 2>&1
  # A clean line-by-line merge can still leave the generated block stale.
  if [ -f scripts/progress-cli.ts ] && npm run -s progress:write >/dev/null 2>&1 && ! git diff --quiet -- README.md; then
    git add README.md && $G commit -q -m "Regenerate the README progress section"
  fi
  ok=1
  if [ -n "$added" ]; then while IFS= read -r l; do grep -qxF -- "$l" "$frag" 2>/dev/null || { echo "$pr LOST CHANGELOG LINE: $l"; ok=0; }; done <<< "$added"; fi
  npm run -s secrets:scan >/dev/null 2>&1 || ok=0
  npm run -s typecheck >/dev/null 2>&1 || ok=0
  npm run -s test:coverage >/dev/null 2>&1 || ok=0
  if [ -f scripts/progress-cli.ts ]; then npm run -s progress:check >/dev/null 2>&1 || ok=0; fi
  if [ -f scripts/changelog-cli.ts ]; then GITHUB_BASE_REF=$base GITHUB_HEAD_REF=$br npm run -s changelog:check >/dev/null 2>&1 || ok=0; fi
  if [ $ok = 1 ]; then git push -q -u origin $br 2>/dev/null && echo "$pr synced and pushed ($frag)"; else echo "$pr FAILED CHECKS, not pushed"; fi
done
