#!/usr/bin/env bash
set -euo pipefail

if (($#)); then
  exec "$@"
fi

/usr/local/bin/orc-project-preflight
node /opt/orc-state/dist/cli/project-init.js
exec node /opt/orc-state/dist/coordinator.js
