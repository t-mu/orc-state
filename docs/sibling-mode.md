# Sibling Orchestration Mode

Sibling mode lets orc drive work on a **target repository** that must stay free
of framework files — no `.orc-state/`, no `backlog/`, no `.gitignore` edits, no
committed or untracked orc artifacts. All orchestration state and specs live in
a separate **orchestration repository** that sits beside the target repo.

This is the mode to use when the project you are orchestrating does not allow
(or you do not want) orchestration files in its version control.

## The two-root model

orc resolves two independent roots:

- **Orchestration root** — orc's home directory. Owns `orc-state.config.json`,
  `.orc-state/` (runtime state), `backlog/` (task specs), `plans/` (plan
  artifacts), and `.worktrees/` (run worktrees). This is where you run orc and
  where the coordinator lives.
- **Target repo root** — the product repository. Receives **only product-code
  commits**. Never receives framework files.

In the default **attached (single-repo) layout** the two roots are the same
directory and everything behaves as it always has. Sibling mode is active only
when a `target_repo` is configured (see below).

```
~/work/
  my-product/                 target repo — untouched by orc
    .git/                     (worktree object store lives here)
    src/ …                    product code only
  my-product.orc/             orchestration root (this is where you run orc)
    orc-state.config.json     target_repo: ../my-product
    .gitignore                ignores .orc-state/ and .worktrees/
    backlog/                  task specs (versioned here)
    plans/                    plan artifacts (versioned here)
    .orc-state/               runtime state (gitignored)
    .worktrees/               run worktrees — each a worktree OF the target repo
```

Worktrees are physically placed under the orchestration root's `.worktrees/`,
but each is a `git worktree` **of the target repo**. A worker edits and commits
product code in its worktree; those commits land in the target repo's history.

## Setup

From an empty directory that will become the orchestration root:

```bash
orc init --sibling=../my-product --provider=claude
```

This scaffolds the orchestration root:

- `git init`s the orchestration root if it is not already a repo,
- writes `.gitignore` with `.orc-state/` and `.worktrees/`,
- writes `orc-state.config.json` with `target_repo` set (a path relative to the
  orchestration root),
- creates `backlog/` and `plans/`,
- installs skills, agents, and MCP config into the orchestration root.

The target must already exist and be a git repository. `orc init --sibling`
rejects a target that does not exist, is not a git repo, or resolves to the
orchestration root itself.

Then start orchestrating as usual:

```bash
orc start-session
```

## What changes in sibling mode

- **Worker Phase 4** — workers do **not** edit the task spec markdown. Product
  merges land in the target repo (which carries no specs), so the coordinator
  writes `status: done` back into the orchestration `backlog/` spec after merge
  and commits it there (`chore(backlog): <task-ref> done`). Workers commit only
  product code and never commit framework files into the target repo. The worker
  bootstrap emits the correct instructions automatically.
- **git operations** — worktree creation/removal, branch deletion, direct-mode
  merges, and PR pushes all run against the target repo. Coordinator state,
  backlog, and plans stay in the orchestration root.
- **`orc` resolution from workers** — the coordinator propagates `ORC_HOME` (the
  orchestration root) into worker sessions so every `orc` command a worker runs
  resolves the orchestration state dir, even though the worker's working
  directory is a target-repo worktree.
- **Sandbox mode** — when `execution_mode: sandbox`, the worker's writable
  workspace is the orchestration-root subtree (covering its worktree, the state
  dir, and the backlog); the target repo's `.git` object store is additionally
  granted so worktree commits succeed. Both Claude and Codex apply this grant
  (Codex's writable-root config override is documented but pending verification
  against a live Codex CLI — see [Configuration → Execution Modes → Codex](./configuration.md)).

## Operating contract

- **Specs are shared; execution is per-machine.** The orchestration repo can be
  pushed and pulled so a team shares one backlog and set of plans, reviewed via
  ordinary git. Runtime state (`.orc-state/`, `events.db`, `memory.db`) is
  machine-local and gitignored — it is never shared.
- **One active coordinator per orchestration clone.** The runtime assumes a
  single coordinator. Claims, leases, and dispatch are local, file-locked, and
  do **not** coordinate across machines. If two people run coordinators against
  clones of the same orchestration repo, coordinate task ownership the way you
  would coordinate branch ownership — otherwise both may claim the same task.
- **Sync a shared orchestration repo manually.** The coordinator does not
  auto-`git pull` the orchestration repo. Pull to pick up new/updated specs; the
  next coordinator tick syncs them into runtime state.

## Verifying the layout

```bash
orc doctor      # validates target_repo resolves to a git repo, state dir is
                # writable, and warns if framework artifacts leaked into the target
orc preflight   # lighter pre-run check including the sibling-layout validation
```

In the attached layout these checks are skipped and output is unchanged.

## Troubleshooting

- **"target_repo is not a git repository"** — the configured `target_repo` does
  not resolve to a git repo. Check the path in `orc-state.config.json` (relative
  to the orchestration root) and that the target has been `git init`ed.
- **"orc framework artifact present in the target repo working tree"** (warning)
  — a `.orc-state/`, `.worktrees/`, or `orc-state.config.json` was found inside
  the target repo. Remove it; framework files belong only in the orchestration
  root.
- **A worker's `orc` command reads the wrong state** — ensure the worker session
  has `ORC_HOME` set to the orchestration root. The coordinator sets this
  automatically; if you launch a worker shell by hand, export `ORC_HOME`
  yourself, or rely on running from inside a worktree (which walks up to the
  orchestration root).
- **Network filesystem warnings** — keep the orchestration root (and thus
  `.orc-state/`, with its SQLite `events.db`/`memory.db` and file locks) on local
  disk. SQLite and file locking are unreliable over NFS/SMB.

## See also

- [Configuration](./configuration.md) — the `target_repo` config key and
  `ORC_HOME` environment variable.
- [Architecture overview](./architecture.md) — the two-root model.
- [Concepts & terminology](./concepts.md) — orchestration root vs target repo.
