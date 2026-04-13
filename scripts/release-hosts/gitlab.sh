#!/usr/bin/env bash
# scripts/release-hosts/gitlab.sh
# Create a GitLab release using the glab CLI.
#
# Usage: gitlab.sh <version> <notes_file>
#   <version>    — version without leading 'v' (e.g., "0.2.0")
#   <notes_file> — path to markdown file containing release notes

set -euo pipefail

VERSION="$1"
NOTES_FILE="$2"

if ! command -v glab >/dev/null 2>&1; then
  echo "error: glab CLI not found on PATH — install from https://gitlab.com/gitlab-org/cli" >&2
  exit 1
fi

if ! glab auth status >/dev/null 2>&1; then
  echo "error: glab CLI is not authenticated. Run 'glab auth login' first." >&2
  exit 1
fi

if [ ! -f "$NOTES_FILE" ]; then
  echo "error: notes file not found: $NOTES_FILE" >&2
  exit 1
fi

glab release create "v${VERSION}" \
  --name "v${VERSION}" \
  --notes-file "$NOTES_FILE"
