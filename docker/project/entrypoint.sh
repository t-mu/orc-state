#!/usr/bin/env bash
set -euo pipefail

if (($#)); then
  exec "$@"
fi

/usr/local/bin/orc-project-preflight
exec node /opt/orc-state/dist/cli/project-runtime.js
