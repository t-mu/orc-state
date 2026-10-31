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
if [[ ! -w "$project_dir" || ! -w "$HOME" || ! -w "$ORC_DATA_HOME" ]]; then
  echo 'Project, project home and data home (state volume) must be writable by the container UID/GID.' >&2
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
# Effective registry setting for the project (empty when unset or unavailable).
setting() { (cd "$project_dir" && orc project config get "$1" 2>/dev/null) | jq -r '.value // empty' 2>/dev/null || true; }
default_provider="$(setting default_provider)"
configured_worker="$(setting worker_pool.provider)"
configured_worker="${configured_worker:-${default_provider:-claude}}"
configured_master="$(setting master.provider)"
configured_master="${configured_master:-${default_provider:-claude}}"
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
