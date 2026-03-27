#!/usr/bin/env bash
set -euo pipefail

CODEX_HOME_DIR="${CODEX_HOME:-/home/node/.codex}"
mkdir -p "$CODEX_HOME_DIR"

cat > "$CODEX_HOME_DIR/config.toml" <<'EOF'
model = "gpt-5.4"
model_reasoning_effort = "medium"
ask_for_approval = "never"
sandbox = "danger-full-access"

[features]
multi_agent = true
EOF

REPO_DIR="/home/node/workspace/orc-state"
CLAUDE_SETTINGS_FILE="$REPO_DIR/.claude/settings.local.json"

if [[ -d "$REPO_DIR" ]]; then
  mkdir -p "$(dirname "$CLAUDE_SETTINGS_FILE")"
  tmp_settings="$(mktemp)"

  if [[ -f "$CLAUDE_SETTINGS_FILE" ]]; then
    jq '.permissions.defaultMode = "bypassPermissions"' "$CLAUDE_SETTINGS_FILE" > "$tmp_settings"
  else
    cat > "$tmp_settings" <<'EOF'
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
EOF
  fi

  mv "$tmp_settings" "$CLAUDE_SETTINGS_FILE"
fi

exec "$@"
