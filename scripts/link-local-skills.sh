#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/skills"

usage() {
  cat <<'EOF'
Usage: scripts/link-local-skills.sh [codex|claude|all]

Create local development symlinks so provider skill discovery points at the
repo's canonical skills/ source directory.

Defaults to: all

Behavior:
- creates .codex/skills -> ../skills
- creates .claude/skills -> ../skills
- backs up an existing non-symlink directory to <path>.bak.<timestamp>
- replaces an existing symlink target
EOF
}

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "skills/ directory not found at: $SOURCE_DIR" >&2
  exit 1
fi

TARGET_SELECTOR="${1:-all}"

if [[ "$TARGET_SELECTOR" == "-h" || "$TARGET_SELECTOR" == "--help" ]]; then
  usage
  exit 0
fi

case "$TARGET_SELECTOR" in
  codex|claude|all) ;;
  *)
    usage >&2
    exit 1
    ;;
esac

link_provider() {
  local provider_dir="$1"
  local target_dir="$ROOT_DIR/$provider_dir"
  local link_path="$target_dir/skills"
  local relative_source="../skills"

  mkdir -p "$target_dir"

  if [[ -L "$link_path" ]]; then
    rm "$link_path"
  elif [[ -e "$link_path" ]]; then
    local backup_path="${link_path}.bak.$(date +%Y%m%d%H%M%S)"
    mv "$link_path" "$backup_path"
    echo "Backed up existing $link_path to $backup_path"
  fi

  ln -s "$relative_source" "$link_path"
  echo "Linked $link_path -> $relative_source"
}

if [[ "$TARGET_SELECTOR" == "codex" || "$TARGET_SELECTOR" == "all" ]]; then
  link_provider ".codex"
fi

if [[ "$TARGET_SELECTOR" == "claude" || "$TARGET_SELECTOR" == "all" ]]; then
  link_provider ".claude"
fi
