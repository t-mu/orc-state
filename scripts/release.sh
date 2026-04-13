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
DOCS=""
OTHER=""

classify_commit() {
  # Echoes one of: feat, fix, changed, docs, other
  # Matches conventional commit prefixes with optional (scope).
  local msg="$1"
  local prefix
  # Extract everything before the first ":" — that's the type[(scope)]
  prefix="${msg%%:*}"
  # Strip optional (scope)
  prefix="${prefix%%(*}"
  case "$prefix" in
    feat)              echo "feat" ;;
    fix)               echo "fix" ;;
    refactor|chore)    echo "changed" ;;
    docs)              echo "docs" ;;
    *)                 echo "other" ;;
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
    docs)     DOCS="${DOCS}- ${summary}"$'\n' ;;
    *)        OTHER="${OTHER}- ${line}"$'\n' ;;
  esac
done <<< "$COMMITS"

# Build the new section
DATE=$(date -u +%Y-%m-%d)
NEW_SECTION="## [${NEW_VERSION}] - ${DATE}"$'\n\n'

[ -n "$ADDED" ]   && NEW_SECTION="${NEW_SECTION}### Added"$'\n\n'"${ADDED}"$'\n'
[ -n "$FIXED" ]   && NEW_SECTION="${NEW_SECTION}### Fixed"$'\n\n'"${FIXED}"$'\n'
[ -n "$CHANGED" ] && NEW_SECTION="${NEW_SECTION}### Changed"$'\n\n'"${CHANGED}"$'\n'
[ -n "$DOCS" ]    && NEW_SECTION="${NEW_SECTION}### Documentation"$'\n\n'"${DOCS}"$'\n'
[ -n "$OTHER" ]   && NEW_SECTION="${NEW_SECTION}### Other"$'\n\n'"${OTHER}"$'\n'

# ── Step 5: Prepend to CHANGELOG.md ───────────────────────────────────────
echo "→ Updating CHANGELOG.md..."

# Insert new section after the header (before the first existing version section).
# CHANGELOG.md format: header, blank line, [<version>] sections in reverse chronological order.
# We prepend the new section directly above the first ## line.
if [ ! -f "$CHANGELOG" ]; then
  echo "error: CHANGELOG.md not found at $CHANGELOG" >&2
  exit 1
fi

# Find line number of first existing "## [" entry
FIRST_VERSION_LINE=$(grep -n '^## \[' "$CHANGELOG" | head -1 | cut -d: -f1)

if [ -n "$FIRST_VERSION_LINE" ]; then
  # Split: header (everything before first ## [...]) + new section + rest
  HEADER=$(head -n $((FIRST_VERSION_LINE - 1)) "$CHANGELOG")
  REST=$(tail -n +"$FIRST_VERSION_LINE" "$CHANGELOG")
  printf '%s\n%s%s\n' "$HEADER" "$NEW_SECTION" "$REST" > "$CHANGELOG"
else
  # No existing version sections — append after current content
  printf '%s\n%s' "$(cat "$CHANGELOG")" "$NEW_SECTION" > "$CHANGELOG"
fi

# Write release notes to a temp file for the host adapter
NOTES_FILE=$(mktemp -t orc-release-notes.XXXXXX)
trap 'rm -f "$NOTES_FILE"' EXIT
printf '%s' "$NEW_SECTION" > "$NOTES_FILE"

# ── Step 6 & 7: Commit and tag ────────────────────────────────────────────
echo "→ Committing and tagging..."
git add "$PACKAGE_JSON" "$CHANGELOG"
git commit -m "chore(release): ${TAG}"
git tag "$TAG"

# ── Step 8: Push ──────────────────────────────────────────────────────────
echo "→ Pushing commit and tag..."
git push origin main
git push origin "$TAG"

# ── Step 9: Create host release page (best-effort) ────────────────────────
echo "→ Creating host release page..."
# shellcheck source=release-hosts/index.sh
source "${SCRIPT_DIR}/release-hosts/index.sh"
create_release "$NEW_VERSION" "$NOTES_FILE"

echo ""
echo "✓ Released ${TAG}"
echo "  Run ./scripts/publish.sh to publish to npm."
