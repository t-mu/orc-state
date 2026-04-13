#!/usr/bin/env bash
# scripts/publish.sh
# Publish the current version to npm. Assumes ./scripts/release.sh has already
# bumped the version, generated the changelog, and tagged the release.
#
# Usage: ./scripts/publish.sh [--otp=<2fa-code>]
#
# Steps:
#   1. Validate working tree is clean
#   2. Validate HEAD is at a release tag (vX.Y.Z)
#   3. Validate package.json version matches the tag
#   4. Verify npm authentication (npm whoami)
#   5. Run npm publish (which triggers prepublishOnly: build, test, smokes)
#   6. Verify the published version appears in the registry

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PACKAGE_JSON="${REPO_ROOT}/package.json"

cd "$REPO_ROOT"

# ── Step 1: Working tree clean ────────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean. Commit or stash changes first." >&2
  git status --short >&2
  exit 1
fi

# ── Step 2: HEAD is at a release tag ──────────────────────────────────────
HEAD_SHA=$(git rev-parse HEAD)
TAG=$(git tag --points-at HEAD | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)

if [ -z "$TAG" ]; then
  echo "error: HEAD is not at a release tag. Run ./scripts/release.sh first." >&2
  echo "  HEAD: $HEAD_SHA" >&2
  exit 1
fi

VERSION="${TAG#v}"
echo "→ Publishing $TAG (version $VERSION)..."

# ── Step 3: package.json version matches tag ──────────────────────────────
PACKAGE_VERSION=$(node -p "require('${PACKAGE_JSON}').version")
if [ "$PACKAGE_VERSION" != "$VERSION" ]; then
  echo "error: package.json version ($PACKAGE_VERSION) does not match tag ($VERSION)" >&2
  exit 1
fi

# ── Step 4: npm authentication ────────────────────────────────────────────
if ! NPM_USER=$(npm whoami 2>/dev/null); then
  echo "error: not logged in to npm. Run 'npm login' first." >&2
  exit 1
fi
echo "  npm user: $NPM_USER"

# ── Step 5: Publish ────────────────────────────────────────────────────────
echo "→ Running npm publish (prepublishOnly will run build + tests + smokes)..."
# Pass through any extra args (e.g., --otp=123456) for 2FA
npm publish "$@"

# ── Step 6: Verify the version is live ────────────────────────────────────
echo "→ Verifying registry..."
PACKAGE_NAME=$(node -p "require('${PACKAGE_JSON}').name")

# Registry can take a few seconds to propagate. Retry up to 6 times (60s total).
for attempt in 1 2 3 4 5 6; do
  REGISTRY_VERSION=$(npm view "$PACKAGE_NAME" version 2>/dev/null || true)
  if [ "$REGISTRY_VERSION" = "$VERSION" ]; then
    echo "✓ Published $PACKAGE_NAME@$VERSION"
    exit 0
  fi
  if [ "$attempt" -lt 6 ]; then
    echo "  registry shows '$REGISTRY_VERSION', expected '$VERSION' — retrying in 10s..."
    sleep 10
  fi
done

echo "warning: registry version verification did not match within 60s" >&2
echo "  expected: $VERSION" >&2
echo "  found:    $REGISTRY_VERSION" >&2
echo "  publish may still have succeeded — check https://www.npmjs.com/package/${PACKAGE_NAME}" >&2
exit 1
