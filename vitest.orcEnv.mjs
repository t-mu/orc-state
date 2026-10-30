// A live orc session (worker, master, coordinator shell) exports ORC_* variables
// naming its project's state dir, control socket and secrets. Runtime modules
// resolve their state from those at import time, so a test inheriting them
// runs against the live project. Every vitest config calls this while it is
// loaded — before any test worker starts — so test processes inherit none of
// them and see only the values a config sets deliberately.
// A developer's real project registry must never select a project for tests either.
export const TEST_DATA_HOME = '/nonexistent/orc-test-data-home';

export function stripInheritedOrcEnv(env = process.env) {
  for (const name of Object.keys(env)) {
    if (name.startsWith('ORC_')) delete env[name];
  }
}
