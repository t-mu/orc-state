#!/usr/bin/env bash
set -euo pipefail

project_dir="${ORC_PROJECT_DIR:-/workspace/project}"
if [[ "$(id -u)" == 0 ]]; then
  echo 'Project runtime must run as a non-root user.' >&2
  exit 1
fi
if [[ ! -d "$project_dir" ]] || ! git -C "$project_dir" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Project mount is missing or is not a Git checkout: $project_dir" >&2
  exit 1
fi
if [[ ! -w "$project_dir" || ! -w "$HOME" || ! -w "$ORC_STATE_DIR" ]]; then
  echo 'Project, project home and state volume must be writable by the container UID/GID.' >&2
  exit 1
fi
git_dir="$(git -C "$project_dir" rev-parse --path-format=absolute --git-common-dir)"
if [[ ! -w "$git_dir" ]]; then
  echo "Git metadata is not writable for worktrees: $git_dir" >&2
  exit 1
fi
for binary in bash node git jq tmux orc; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "Required tool is missing: $binary" >&2
    exit 1
  fi
done
if [[ "$(node --version)" != v24.* ]]; then
  echo 'Project runtime requires Node 24.' >&2
  exit 1
fi
configured_worker="$(jq -r '.worker_pool.provider // .default_provider // "claude"' "$project_dir/orc-state.config.json" 2>/dev/null || echo claude)"
configured_master="$(jq -r '.master.provider // .default_provider // "claude"' "$project_dir/orc-state.config.json" 2>/dev/null || echo claude)"
for provider in "${ORC_WORKER_PROVIDER:-$configured_worker}" "${ORC_MASTER_PROVIDER:-$configured_master}"; do
  if ! command -v "$provider" >/dev/null 2>&1; then
    echo "Provider binary is missing: $provider" >&2
    exit 1
  fi
  case "$provider" in
    codex) auth_command=(codex login status) ;;
    claude) auth_command=(claude auth status) ;;
    gemini)
      if [[ ! -d "$HOME/.gemini" && -z "${GEMINI_API_KEY:-}" && -z "${GOOGLE_API_KEY:-}" ]]; then
        echo 'Gemini login is missing; run gemini in the project container first.' >&2
        exit 1
      fi
      continue
      ;;
    *) echo "Unsupported provider: $provider" >&2; exit 1 ;;
  esac
  if ! "${auth_command[@]}" >/dev/null 2>&1; then
    echo "Provider login is missing for $provider; use orc-project.sh login $provider." >&2
    exit 1
  fi
done

echo "Project preflight passed (uid=$(id -u), gid=$(id -g), git=$project_dir)."
