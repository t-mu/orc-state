#!/usr/bin/env bash
# scripts/release.sh
# Bump version, generate changelog from conventional commits, tag, push,
# create host release page. Fully deterministic — no editor, no prompts.
#
# Usage: ./scripts/release.sh <patch|minor|major>
#
# Steps:
#   1. Validate working tree is clean and on main branch
#   2. Run `npm test` (gate)
#   3. Bump version in package.json (no commit, no tag yet)
#   4. Read commits since last tag, group by conventional commit prefix
#   5. Prepend new section to CHANGELOG.md
#   6. Commit changelog + version bump
#   7. Tag vX.Y.Z
#   8. Push commit and tag
#   9. Create host release page (best-effort via release-hosts adapter)

set -euo pipefail

# ── Paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CHANGELOG="${REPO_ROOT}/CHANGELOG.md"
PACKAGE_JSON="${REPO_ROOT}/package.json"

cd "$REPO_ROOT"

# ── Argument validation ────────────────────────────────────────────────────
if [ $# -ne 1 ]; then
  echo "usage: $0 <patch|minor|major>" >&2
  exit 1
fi

BUMP="$1"
case "$BUMP" in
  patch|minor|major) ;;
  *)
    echo "error: bump must be one of: patch, minor, major (got '$BUMP')" >&2
    exit 1
    ;;
esac

# ── Step 1: Validate working tree ──────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean. Commit or stash changes first." >&2
  git status --short >&2
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "error: must be on main branch (currently on '$CURRENT_BRANCH')" >&2
  exit 1
fi

# Verify we're up to date with origin
git fetch origin main --quiet
LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "error: local main is not in sync with origin/main" >&2
  echo "  local:  $LOCAL" >&2
  echo "  remote: $REMOTE" >&2
  exit 1
fi

# ── Step 2: Run tests ──────────────────────────────────────────────────────
echo "→ Running tests..."
npm test

# ── Step 3: Bump version (no commit, no tag yet) ──────────────────────────
echo "→ Bumping version ($BUMP)..."
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version)
NEW_VERSION="${NEW_VERSION#v}"  # strip leading 'v'
TAG="v${NEW_VERSION}"
echo "  new version: $NEW_VERSION"

# ── Step 4: Generate changelog from commits ───────────────────────────────
echo "→ Generating changelog from commits..."

# Find the previous tag (most recent semver tag). May not exist for first release.
PREV_TAG=$(git tag --sort=-version:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)

if [ -n "$PREV_TAG" ]; then
  COMMIT_RANGE="${PREV_TAG}..HEAD"
  echo "  range: $COMMIT_RANGE"
else
  COMMIT_RANGE="HEAD"
  echo "  range: full history (no previous tag found)"
fi

# Read commits, parse conventional prefixes, group by category.
# Skip release commits to avoid recursion.
COMMITS=$(git log "$COMMIT_RANGE" --pretty=format:"%s" --no-merges \
  | grep -v '^chore(release):' \
  || true)

ADDED=""
FIXED=""
CHANGED=""
OTHER=""

classify_commit() {
  # Echoes one of: feat, fix, changed, other
  # Matches conventional commit prefixes with optional (scope).
  # Aligned with Keep a Changelog standard categories (Added, Changed, Fixed).
  # docs/refactor/chore commits all fold into "Changed".
  local msg="$1"
  local prefix
  # Extract everything before the first ":" — that's the type[(scope)]
  prefix="${msg%%:*}"
  # Strip optional (scope)
  prefix="${prefix%%(*}"
  case "$prefix" in
    feat)                       echo "feat" ;;
    fix)                        echo "fix" ;;
    refactor|chore|docs|test)   echo "changed" ;;
    *)                          echo "other" ;;
  esac
}

extract_summary() {
  # Strip the "type[(scope)]: " prefix from a conventional commit message.
  # If no prefix matches, returns the original message unchanged.
  local msg="$1"
  case "$msg" in
    *:\ *)  echo "${msg#*: }" ;;
    *)      echo "$msg" ;;
  esac
}

while IFS= read -r line; do
  [ -z "$line" ] && continue
  category=$(classify_commit "$line")
  summary=$(extract_summary "$line")
  case "$category" in
    feat)     ADDED="${ADDED}- ${summary}"$'\n' ;;
    fix)      FIXED="${FIXED}- ${summary}"$'\n' ;;
    changed)  CHANGED="${CHANGED}- ${summary}"$'\n' ;;
    *)        OTHER="${OTHER}- ${summary}"$'\n' ;;
  esac
done <<< "$COMMITS"

# Build the new section
DATE=$(date -u +%Y-%m-%d)
NEW_SECTION="## [${NEW_VERSION}] - ${DATE}"$'\n\n'

[ -n "$ADDED" ]   && NEW_SECTION="${NEW_SECTION}### Added"$'\n\n'"${ADDED}"$'\n'
[ -n "$CHANGED" ] && NEW_SECTION="${NEW_SECTION}### Changed"$'\n\n'"${CHANGED}"$'\n'
[ -n "$FIXED" ]   && NEW_SECTION="${NEW_SECTION}### Fixed"$'\n\n'"${FIXED}"$'\n'
[ -n "$OTHER" ]   && NEW_SECTION="${NEW_SECTION}### Other"$'\n\n'"${OTHER}"$'\n'

# ── Step 5: Prepend to CHANGELOG.md ───────────────────────────────────────
echo "→ Updating CHANGELOG.md..."

if [ ! -f "$CHANGELOG" ]; then
  echo "error: CHANGELOG.md not found at $CHANGELOG" >&2
  exit 1
fi

# Check if this version already has an entry — if so, skip insertion (idempotent).
if grep -q "^## \[${NEW_VERSION}\]" "$CHANGELOG"; then
  echo "  CHANGELOG.md already has an entry for [${NEW_VERSION}] — skipping insertion"
else
  # Find line number of first existing "## [" entry
  FIRST_VERSION_LINE=$(grep -n '^## \[' "$CHANGELOG" | head -1 | cut -d: -f1)
  TMP_CHANGELOG="${CHANGELOG}.tmp"

  if [ -n "$FIRST_VERSION_LINE" ]; then
    # Stream-insert without command substitution to preserve trailing newlines.
    {
      head -n $((FIRST_VERSION_LINE - 1)) "$CHANGELOG"
      printf '%s' "$NEW_SECTION"
      tail -n +"$FIRST_VERSION_LINE" "$CHANGELOG"
    } > "$TMP_CHANGELOG"
  else
    # No existing version sections — append after current content
    {
      cat "$CHANGELOG"
      printf '\n%s' "$NEW_SECTION"
    } > "$TMP_CHANGELOG"
  fi
  mv "$TMP_CHANGELOG" "$CHANGELOG"
fi

# Write release notes to a temp file for the host adapter
NOTES_FILE=$(mktemp -t orc-release-notes.XXXXXX)
trap 'rm -f "$NOTES_FILE"' EXIT
printf '%s' "$NEW_SECTION" > "$NOTES_FILE"

# ── Step 6 & 7: Commit and tag ────────────────────────────────────────────
echo "→ Committing and tagging..."
# Stage package.json, package-lock.json (npm version updates both), and CHANGELOG.md.
PACKAGE_LOCK="${REPO_ROOT}/package-lock.json"
git add "$PACKAGE_JSON" "$CHANGELOG"
[ -f "$PACKAGE_LOCK" ] && git add "$PACKAGE_LOCK"
git commit -m "chore(release): ${TAG}"
git tag "$TAG"

# ── Step 8: Push (atomic) ──────────────────────────────────────────────────
echo "→ Pushing commit and tag..."
# Atomic push so commit and tag arrive together. If this fails, the local
# state has the commit and tag but origin doesn't — re-running the script
# will fail at the sync check (Step 1). Recovery: `git push origin main "$TAG"`
# manually after fixing the underlying issue.
if ! git push --atomic origin main "$TAG"; then
  echo "" >&2
  echo "error: push failed. Local has commit and tag '$TAG', but origin does not." >&2
  echo "  Recovery: fix the push failure, then run: git push origin main $TAG" >&2
  exit 1
fi

# ── Step 9: Create host release page (best-effort) ────────────────────────
echo "→ Creating host release page..."
# shellcheck source=release-hosts/index.sh
source "${SCRIPT_DIR}/release-hosts/index.sh"
# Best-effort: tag is already pushed, so a host release page failure should not
# fail the entire release. The user can create the release page manually later.
if ! create_release "$NEW_VERSION" "$NOTES_FILE"; then
  echo "warning: host release page creation failed — tag $TAG is pushed, you can create the release page manually" >&2
fi

echo ""
echo "✓ Released ${TAG}"
echo "  Run 'npm run release:publish' to publish to npm."
