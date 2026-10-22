#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_dir="$(cd -- "${ORC_PROJECT_DIR:-$PWD}" && pwd -P)"
if ! git -C "$project_dir" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Not a Git checkout: $project_dir" >&2
  exit 1
fi
if [[ "$(id -u)" == 0 ]]; then
  echo 'Run this launcher as the host user who owns the project checkout.' >&2
  exit 1
fi
command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 1; }
mkdir -p "$project_dir/.orc-state"
project_slug="$(basename "$project_dir" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | cut -c1-24)"
project_hash="$(printf '%s' "$project_dir" | cksum | awk '{print $1}')"
project_name="orc-${project_slug}-${project_hash}"
export ORC_PROJECT_DIR="$project_dir"
export ORC_UID="$(id -u)"
export ORC_GID="$(id -g)"
export ORC_PROJECT_IMAGE="${ORC_PROJECT_IMAGE:-orc-project:$project_name}"
compose=(docker compose --project-name "$project_name" -f "$script_dir/compose.yml")

case "${1:-}" in
  build) "${compose[@]}" build ;;
  up) "${compose[@]}" up --build -d ;;
  down) "${compose[@]}" down ;;
  status) "${compose[@]}" ps ;;
  shell) "${compose[@]}" exec project bash ;;
  preflight) "${compose[@]}" exec project /usr/local/bin/orc-project-preflight ;;
  login)
    provider="${2:-claude}"
    case "$provider" in claude|codex|gemini|gh) ;; *) echo "Unknown login tool: $provider" >&2; exit 2 ;; esac
    login_args=()
    if [[ "$provider" == codex || "$provider" == gh ]]; then login_args=(login); fi
    "${compose[@]}" run --rm --no-deps --entrypoint "$provider" project "${login_args[@]}"
    ;;
  master)
    provider="${2:-claude}"
    "${compose[@]}" exec project orc start-session "--provider=$provider"
    ;;
  *)
    echo 'Usage: orc-project.sh <build|login [provider]|up|down|status|shell|preflight|master [provider]>' >&2
    exit 2
    ;;
esac
