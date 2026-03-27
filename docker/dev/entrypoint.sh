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
CLAUDE_HOME_DIR="/home/node/.claude"
CLAUDE_HOME_SETTINGS_FILE="$CLAUDE_HOME_DIR/settings.json"
CLAUDE_PROJECT_SETTINGS_FILE="$REPO_DIR/.claude/settings.local.json"

write_claude_settings() {
  local target_file="$1"
  local tmp_settings
  tmp_settings="$(mktemp)"

  if [[ -f "$target_file" ]]; then
    jq '
      .enabledMcpjsonServers = ["orchestrator"]
      | .enableAllProjectMcpServers = true
      | .permissions.defaultMode = "bypassPermissions"
      | .skipDangerousModePermissionPrompt = true
    ' "$target_file" > "$tmp_settings"
  else
    cat > "$tmp_settings" <<'EOF'
{
  "enabledMcpjsonServers": [
    "orchestrator"
  ],
  "enableAllProjectMcpServers": true,
  "permissions": {
    "defaultMode": "bypassPermissions"
  },
  "skipDangerousModePermissionPrompt": true
}
EOF
  fi

  mkdir -p "$(dirname "$target_file")"
  mv "$tmp_settings" "$target_file"
}

write_claude_settings "$CLAUDE_HOME_SETTINGS_FILE"

if [[ -d "$REPO_DIR" ]]; then
  write_claude_settings "$CLAUDE_PROJECT_SETTINGS_FILE"
fi

exec "$@"
