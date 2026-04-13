#!/usr/bin/env bash
# scripts/release-hosts/github.sh
# Create a GitHub release using the gh CLI.
#
# Usage: github.sh <version> <notes_file>
#   <version>    — version without leading 'v' (e.g., "0.2.0")
#   <notes_file> — path to markdown file containing release notes

set -euo pipefail

VERSION="$1"
NOTES_FILE="$2"

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found on PATH — install from https://cli.github.com/" >&2
  exit 1
fi

if [ ! -f "$NOTES_FILE" ]; then
  echo "error: notes file not found: $NOTES_FILE" >&2
  exit 1
fi

gh release create "v${VERSION}" \
  --title "v${VERSION}" \
  --notes-file "$NOTES_FILE"
