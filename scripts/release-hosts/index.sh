#!/usr/bin/env bash
# scripts/release-hosts/index.sh
# Dispatcher: detects git host from remote URL and delegates to a host adapter.
#
# Usage: source release-hosts/index.sh, then:
#   create_release <version> <notes_file>
#
# Adapters live in the same directory as this file:
#   - github.sh — uses gh CLI
#   - gitlab.sh — uses glab CLI
#
# Adding a new host: drop a new <host>.sh file and add a case in detect_host below.

set -euo pipefail

# Resolve the directory containing this script (and adapters).
HOSTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect host from `git remote get-url origin`. Echoes one of: github, gitlab, "".
detect_host() {
  local url
  if ! url=$(git remote get-url origin 2>/dev/null); then
    echo ""
    return 0
  fi
  case "$url" in
    *github.com*)             echo "github" ;;
    *gitlab.com*|*gitlab.*)   echo "gitlab" ;;
    *)                         echo "" ;;
  esac
}

# Create a release page for the given version using the detected host's CLI.
# Arguments:
#   $1 — version (without leading 'v', e.g., "0.2.0")
#   $2 — path to notes file (markdown)
#
# Exits 0 on success, prints warning and exits 0 if no host detected (best-effort).
# Exits non-zero only if the host adapter itself fails.
create_release() {
  local version="$1"
  local notes_file="$2"
  local host
  host=$(detect_host)

  case "$host" in
    github)
      bash "${HOSTS_DIR}/github.sh" "$version" "$notes_file"
      ;;
    gitlab)
      bash "${HOSTS_DIR}/gitlab.sh" "$version" "$notes_file"
      ;;
    "")
      echo "warning: no supported git host detected from origin — tag pushed but no release page created" >&2
      return 0
      ;;
    *)
      echo "warning: unknown host '$host' — tag pushed but no release page created" >&2
      return 0
      ;;
  esac
}
