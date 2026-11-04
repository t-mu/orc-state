# Doc audit (2026-11-04)

Scope: all tracked `*.md` except `CHANGELOG.md`. Line refs are against `main` @ `19fe022`.
Tags: **OUTDATED** (wrong vs code → current truth), **DELETE** (remove), **TRIM** (correct but wordy → how).
Temporary file: delete it once the cleanup tasks land.

## Code bugs found while auditing (not doc issues)

| # | Bug | Evidence |
|---|-----|----------|
| 1 | Subcommands ignore `--help` and **execute**: `kill-all`, `worker-gc`, `worker-remove`, `start-session`, `install-agents` (an audit `orc kill-all --help` stopped the live coordinator). No subcommand handles `--help`; only bare `orc --help` does. | `cli/orc.ts:198`; no `help` check in any `cli/*.ts` |
| 2 | `review-read` shows one review per agent_id (latest wins), but the workflow has every reviewer submit with the **worker's** agent_id → with 2 reviewers only 1 is visible; the "all reviewers approved" gate can't be checked. | `lib/projectReads.ts:48-71`, `lib/workerLifecycle.ts:315` |
| 3 | `agents/reviewer.md` has no `description:` frontmatter → Claude Code doesn't register it; `review_level: light` points workers at it. | `agents/reviewer.md:1-9`, worker bootstrap L98 |
| 4 | `ORC_STRICT_PTY_TESTS` / `ORC_PTY_AVAILABLE` are stripped by `stripInheritedOrcEnv` before tests run → the documented switches do nothing. | `vitest.orcEnv.mjs`, `test-fixtures/ptySupport.ts:39-40` |
| 5 | Config keys are loaded but unused: `run_inactive_timeout_ms`, `run_inactive_escalate_ms`, `leases.finalize_ms` (constant `FINALIZE_LEASE_MS` is used instead). | `lib/workerLifecycleReducer.ts`, `lib/providers.ts` |
| 6 | Events in the schema that are never emitted: `claim_renewed`, `claim_released`, `task_released`. `run-heartbeat` is a deprecated no-op but still dispatched. | `schemas/event.schema.json`, `cli/orc.ts` |

## Summary

| file | lines | verdict | est. after |
|------|------:|---------|-----------:|
| AGENTS.md | 511 | trim hard → repo dev guide + pointers; worker protocol lives in `templates/worker-bootstrap-v2.txt` | 90 |
| CLAUDE.md | 2 | keep (`@AGENTS.md`) | 2 |
| README.md | 78 | trim | 45 |
| contracts.md (root) | 155 | **delete** (dup of docs/contracts, adapters, cli) | 0 |
| ORC_STATE_VNEXT_IMPLEMENTATION_BRIEF.md | 255 | **delete** (brief; implemented or superseded) | 0 |
| docs/vnext-architecture.md | 105 | **delete** (self-declared historical) | 0 |
| docs/vnext-provider-protocols.md | 190 | **delete** (spike log; 3 lines → testing.md) | 0 |
| docs/concepts.md | 166 | merge into architecture.md as glossary | 0 |
| docs/global-project-contract.md | 49 | merge into contracts.md (lifecycle) + configuration.md (selection) | 0 |
| docs/troubleshooting.md | 232 | merge into recovery.md as symptom table | 0 |
| docs/contracts.md | 776 | trim; canonical for state files, lifecycle, events, control API, invariants | 350 |
| docs/cli.md | 467 | trim | 320 |
| docs/configuration.md | 470 | trim; move security model to contracts.md | 230 |
| docs/recovery.md | 334 | trim + absorb troubleshooting | 150 |
| docs/memory.md | 485 | trim | 120 |
| docs/architecture.md | 173 | trim + absorb concepts glossary | 90 |
| docs/adapters.md | 249 | trim | 70 |
| docs/getting-started.md | 179 | trim | 65 |
| docs/testing.md | 185 | trim | 60 |
| docs/task-template.md | 143 | trim | 55 |
| docs/plan-template.md | 49 | trim; canonical plan format | 45 |
| docker/dev/README.md | 124 | trim | 55 |
| docker/project/README.md | 84 | trim | 50 |
| test-fixtures/README.md | 58 | trim | 25 |
| agents/critic.md | 71 | trim | 40 |
| agents/integrator.md | 65 | trim (or merge into critic) | 35 |
| agents/reviewer.md | 40 | keep; fix frontmatter (bug 3) | 25 |
| agents/state-auditor.md | 67 | trim | 35 |
| agents/task-auditor.md | 63 | trim | 35 |
| agents/test-runner.md | 44 | trim | 25 |
| skills/orc-commands/SKILL.md | 162 | trim → cheat-sheet linking docs/cli.md | 90 |
| skills/worker-inspect/SKILL.md | 52 | trim + fix | 35 |
| **total** | **~6,080** | **7 files removed** | **~2,320 (−62%)** |

---

## AGENTS.md
- OUTDATED L10-12: "file-state … headless PTY sessions" → SQLite + JSON projections; tmux sessions, else PTY, or `app:`.
- OUTDATED L20: "no build step" → installed `orc` runs `dist/`; `npm run build` needed.
- OUTDATED L43: pre-authorizes `git worktree add`, `git -C ../.. merge` → worktrees are `<state>/worktrees/<run_id>`; workers never merge or create worktrees.
- OUTDATED L76-80: explore signalled before `run-start` → bootstrap runs `run-start` first.
- OUTDATED L94-98, L108: "two reviewers (critic, integrator)" → count depends on `review_level`: none = self, light = reviewer.md, full = critic + integrator.
- OUTDATED L104-107, L138: "all submitted reviewers approved" gate → not checkable (bug 2).
- OUTDATED L172-173: PR_REVIEW field list misses `task_ref`.
- OUTDATED L252: "PTY session" → tmux/PTY.
- DELETE L47-66: merge/cleanup ordering. The coordinator / `orc run-close` does it; contradicts L191-192.
- DELETE L90-141, L162-192: Phase 3-5 text; near-verbatim copy of the bootstrap, already drifted → "Workers: follow WORKER_BOOTSTRAP".
- DELETE L159-160, L196 (empty `## Commands`), L266-267, L441-448: filler / repeats.
- DELETE L213-281: command reference → pointer to docs/cli.md.
- DELETE L288-298: state files → pointer to docs/contracts.md.
- DELETE L315-326: execution modes → pointer to docs/configuration.md.
- DELETE L348-382: liveness internals → docs/contracts.md.
- DELETE L386-437: Scout role (master and scout templates own it).
- DELETE L483-500: Interactive Prompt Rule (bootstrap L204-226).
- TRIM L181-189: `run-finish` said 3 times → 1 line.
- TRIM L200-211: Blessed Paths → 5 bullets; "status is runtime-owned" stated once (also L146, L157, L304, L447).
- TRIM L300-313: → 1 line "Task/plan format: docs/task-template.md, docs/plan-template.md".
- TRIM L328-346: keep the lifecycle diagram + eligibility line only.
- TRIM L450-479, L504-511: → 4 dev bullets.

## CLAUDE.md
- No findings.

## README.md
- OUTDATED L9, L13: "locally in your repo, nothing but files" → SQLite + control socket, outside the repo.
- DELETE L12: restates L11.
- DELETE L33-42: duplicates getting-started → 1 line.
- TRIM L44-60: → 3 bullets.

## contracts.md (root): delete
- OUTDATED throughout: state is JSON-only (L7-12), `pty:` handles (L24-34), `orc-attach` (L46), the 5-method adapter (L50-56), run-heartbeat required (L93-107), 18 of ~52 commands (L129-148), `.mjs` (L155).
- DELETE L1-155. **Also update `lib/prompts.test.ts:145-159`**, which reads this file.

## ORC_STATE_VNEXT_IMPLEMENTATION_BRIEF.md: delete
- OUTDATED L28, L72-73, L141, L231: "Markdown canonical; SQLite not the sole copy" → reversed.
- OUTDATED L9, L131: `lib/backlogSync.ts`, `orc runs/logs/shell` → removed / renamed.
- DELETE L1-255. Still open, file a task only if wanted: loopback TCP control transport, Claude structured adapter.

## docs/vnext-architecture.md: delete
- OUTDATED L12-13, L33, L40, L100-105: "untracked", direct library calls, `backlog/*.md` → none of these hold any more.
- DELETE L1-105. Move L62-66 (operational tables in events.db; memory.db separate) to docs/contracts.md.

## docs/vnext-provider-protocols.md: delete
- DELETE L1-190: spike log from 2026-10-17; the outcomes are already in configuration.md "Worker Runtimes".
- Move L20-28 (smoke usage `node scripts/vnext-provider-smoke.ts codex|claude`, `ORC_*_SMOKE_BINARY`) → docs/testing.md.
- Update comments `adapters/runtime.ts:11` and `adapters/codexAppServer.ts:6`.

## docs/concepts.md: merge into architecture.md
- OUTDATED L107: ref `<feature>/<task-number>-<slug>` → `<feature>/<slug>`.
- OUTDATED L109: "backlog file paths" → none.
- OUTDATED L120: `.worktrees/` → `<state>/worktrees/<run_id>`.
- DELETE L15-16, L26-27, L37-38, L48-49, L60, L78, L88, L99, L109, L120-121, L131-132, L143-144, L158: "You'll encounter this…" filler.
- DELETE L9-49: role descriptions (dup of architecture.md L46-81).
- DELETE L66-76: plan contract (→ plan-template.md).
- DELETE L148-158: two-root model (dup of architecture.md).
- TRIM rest: → glossary table (term | 1 line) in architecture.md.

## docs/global-project-contract.md: merge
- OUTDATED L3: "target contract for plan 3" → implemented.
- OUTDATED L40: `todo → blocked` by operator → no command for it (`manual_block` has no caller).
- OUTDATED L41, L43: migration replay / `migration_import` → migration removed.
- DELETE L9, L15: duplicate configuration.md.
- TRIM L11: one-paragraph auth → table (command group | control API / direct fallback) in contracts.md.
- TRIM L32-45: **most accurate lifecycle table**; move it to contracts.md as the canonical one.
- TRIM L49: → 1 line "proved by `e2e/clean-repo-project.e2e.test.ts`".

## docs/troubleshooting.md: merge into recovery.md
- OUTDATED L56-68: error "Must run inside a git repository" doesn't exist → "No registered project here…" (`lib/paths.ts:33`) / "target repository is not a git repository" (`lib/projectLayoutCheck.ts:51`).
- OUTDATED L94, L174: bare `orc delegate` → needs `--task-ref`; dispatch is automatic.
- OUTDATED L101, L119: crash → requeue → tmux sessions are adopted, pty sessions are marked `recoverable`, only `app:` runs are requeued.
- OUTDATED L125: "30 min without heartbeat" → 30-min lease renewed automatically; a dead process expires the claim at once; idle thresholds `worker_stale_*`, `hook_idle_*`, no-progress 60 min.
- OUTDATED L181: state file list → add runtime.db/events.db; backlog.json is a projection.
- DELETE L5, L72-95, L113-117, L123-146, L201 (last sentence): repeats of recovery.md / legacy.
- TRIM L9-52: → table provider | install | auth env.
- TRIM L150-175, L213-224: → 3 bullets / 1 line.

## docs/contracts.md
- OUTDATED L7-9: global-project-contract called "future" → implemented.
- OUTDATED L19-25: missing memory.db; claims are authoritative in events.db `runs` (claims.json is a projection, `lib/runStore.ts:188`).
- OUTDATED L27-38: aux files missing operator.token, run-worktrees.json, project.json, worktrees/, run-specs/, event-checkpoint.json, pty-settings/, mcp-config.json.
- OUTDATED L68-89, L160-176, L203-226, L236-243: hand-copied schema fields are missing model, review_level, merge_strategy, spec_revision, ephemeral, pr_*, task_spec_snapshot, the `pr_*` finalization states.
- OUTDATED L101-128: done is triggered by task-mark-done → coordinator merge (`merge_succeeded`).
- OUTDATED L138-140: `any→blocked`, reset scope, `any→cancelled` MCP-only → see global-project-contract L32-45 (correct). Missing requeue and unblock rows.
- OUTDATED L144-147: eligibility → also `planning_state=ready_for_dispatch` and owner (`lib/taskScheduler.ts:45-47`).
- OUTDATED L284-286: liveness via `process.kill(pid,0)` → tmux pane probe / PTY PID + start time.
- OUTDATED L300, L750: `task_ref` must exist in backlog.json → runtime.db.
- OUTDATED L331: worker calls task-mark-done → coordinator records done; worker gets FINALIZE_SUCCESS → `run-finish`.
- OUTDATED L347-348: preconditions → run-work-complete: in_progress + finalization null/rebase_in_progress; run-finish: task done/released.
- OUTDATED L409-417: events.db schema v1/v2 → v7.
- OUTDATED L427: `event_id` required → optional.
- OUTDATED L440-565: missing `review_submitted` and 10 `command_*` events; L456/458/467 never emitted (bug 6); L548-549 `blocked`/`unblocked` only via `orc progress`.
- OUTDATED L644-645: command delivery "not wired" → `CommandDispatcher` is wired for `app:` sessions.
- OUTDATED L698-709: transports tmux/pty → plus `app:`.
- OUTDATED L762-767: invariant 6 compares backlog.json/claims.json → runtime.db vs events.db runs.
- DELETE L282-293 (keep one liveness section here, fixed), L295-302 (dup of L742+), L413-417 (migration history), L593-594, L610, L656 (task numbers), L772-776 (See also).
- TRIM L49-95, L151-250: schema tables → link `schemas/*.schema.json`, keep enums.
- TRIM L33-35, L256-269, L315-378: → 1-line cells / numbered lists.
- TRIM L438-565: 7 event tables → 1 table (event | emitter | note).
- TRIM L481-529: keep the L485-491 table + 4 bullets.
- TRIM L603-672: auth prose → 5 bullets + one auth table.

## docs/cli.md
- OUTDATED L49, L80, L114: doctor is missing `--stale-progress-ms`, `--stale-start-ms`.
- OUTDATED L245: delegate is missing `--actor-id`.
- OUTDATED L390-391: progress is missing `--policy`; run-input-request is missing `--poll-ms`.
- OUTDATED L443: `pr-status` is missing `[--wait]`.
- OUTDATED L183-189: no `terminal` row (`<provider|shell> <run_id> [--write] [--once]`).
- OUTDATED (missing): `run-heartbeat` (deprecated no-op) and `project add|list|select|show|config` are not listed.
- OUTDATED L223: actor-id rule "applies to run-expire" → run-expire doesn't parse it.
- OUTDATED L328: "queued commands not yet delivered" → `CommandDispatcher` delivers them.
- OUTDATED L357: "PTY sessions" → tmux/PTY.
- OUTDATED L377: progress = phase_started/finished → 14 events (`lib/progressValidation.ts`).
- OUTDATED L264-265: "backlog specs use prose `Depends on Task N`" → tasks use `depends_on:` frontmatter.
- DELETE L14, L67, L154-156, L195-197, L279, L334-336, L449-450: section intros.
- DELETE L132-134 (repeats L29-34), L224 (history), L313-314 (migration backup), L458-466 (Skills; dup of Setup table).
- DELETE L249-273: plan format → plan-template.md + 1-line link.
- TRIM L10, L18-34, L40-120, L165-181: → bullets / table cells.
- TRIM L199-235, L318-328, L360-368: auth/fallback/control API → 4 bullets + link to contracts.md.
- TRIM L287, L404, L420: long table cells → 1 line.

## docs/configuration.md
- OUTDATED L5: "(new project API)" → no other API exists; rename (update anchor at cli.md L368).
- OUTDATED L24: `migration.json` is ignored → nothing references it; delete.
- OUTDATED L94-133: env table missing `ORC_DEFAULT_PROVIDER`, `ORC_DEFAULT_EXECUTION_MODE`, `ORC_LOG_LEVEL`, `ORC_SCOUT_READY_TIMEOUT_MS`.
- OUTDATED L198: `concurrency_limit` = max concurrent runs → per-tick dispatch/nudge parallelism; the cap is `max_workers`.
- OUTDATED L203, L205, L228: keys that are not used (bug 5).
- OUTDATED L221: "all coordinator fields are CLI flags (`--tick-interval-ms`)" → the flag is `--interval-ms`; many fields have no flag.
- DELETE L32 ("task 231"), L329 ("task 204"), L33 (upgrade history), L86, L90 (retired keys), L156-158, L288, L291, L339 (last sentence), L356, L393.
- DELETE L309-316, L395-415, L448-464: repeat tables, examples, setup.
- DELETE L427-446: state layout → link contracts.md.
- TRIM L20/L24/L39: project selection said 3× → one 4-step list (canonical here).
- TRIM L26, L41, L55, L86-92: → bullets.
- TRIM L32-35, L57: secrets/auth/operator token → contracts.md; 4 one-line bullets here.
- TRIM L59-70: task lifecycle → contracts.md.
- TRIM L174-182, L209, L213-215: → one short cell each + link.
- TRIM L240-276: app-server runtime → 6 bullets.
- TRIM L282, L331-354, L362-370: sandbox → per-provider table + 2-line Docker-socket warning; scout override → 3 bullets.

## docs/recovery.md
- OUTDATED L149: worker states "offline or error" → idle|running|offline|dead.
- OUTDATED L213-241: `.worktrees/<run_id>` → `<state>/worktrees/<run_id>`.
- OUTDATED L267: "inspect the task spec" → `orc project task show <ref>`.
- OUTDATED L282: bare `orc delegate` → dispatch is automatic; drop it.
- OUTDATED L313-322: "kill-all leaves unmerged worktrees" → kill-all resets active tasks, cancels claims and **removes all run worktrees** (unmerged work lost); `--keep-sessions` undocumented.
- DELETE L23-37: migration/version and session-secret upgrade history.
- DELETE L93-109: run-close semantics (dup of cli.md) → 1 line.
- DELETE L141-145, L207-211, L249-252, L285-289: "why it happens" prose.
- DELETE L313-318: kill-all detection internals.
- TRIM L6-57: backup/restore → 2 code blocks; drop backlog.json (projection).
- TRIM L111-139: → 2-3 bullets each.
- TRIM all Symptoms/Diagnosis/Fix scaffolding → one table: symptom | check | fix (absorbs troubleshooting.md).

## docs/memory.md
- OUTDATED L35-36: "coordinator initializes DB on first use" → `ensureStateInitialized` (init / project add / start-session).
- OUTDATED L206: wake-up silent without DB → prints "Memory store not initialized…".
- OUTDATED L251: MCP arg `budget` → `tokenBudget`.
- OUTDATED L346-349: hardcoded `/home/node/.npm-global/bin/orc` → `{{orc_bin}}`.
- OUTDATED L424-432: auto-recording → review only when outcome=findings (importance 6); input responses only via `run-input-respond` (importance 7).
- OUTDATED L457: room cap configurable → hardcoded 200; pruning at coordinator start + hourly.
- OUTDATED L471-479: doctor output format → `memory health: ok=<bool>` + messages.
- DELETE L3-27, L39-78, L102-103, L123-132, L136-235, L242-335, L354-362, L378-386, L438-465: intro, internals, CLI/MCP references (dup of cli.md / tools-list), pseudo-code.
- TRIM L84-121: wing/hall/room → 1 table.
- TRIM L390-422: auto-ingestion → table trigger | hall/room | importance.

## docs/architecture.md
- OUTDATED L13: "task specs as markdown files" → runtime.db (import/export only).
- OUTDATED L15-16, L99-100, L161-162: coordinator rebases → worker rebases; coordinator merges or requests a finalize rebase.
- OUTDATED L33, L70, L157: `.worktrees/` → `<state>/worktrees/`.
- OUTDATED L50, L96: PTY PID probing, claim in claims.json → tmux/PTY probe; events.db runs.
- OUTDATED L94, L145-147: capacity = max_workers − registered agents → − agents with active claims (`coordinator.ts:1714`).
- TRIM L91-92: eligibility is derived, not "marked".
- DELETE L106-121 (state dir → contracts.md), L67-68 or L150-153 (worker names twice), L169-173 (See also).
- TRIM L46-81: → 4-row table role | process | owns; L125-138 → 2 bullets; add the concepts glossary.

## docs/adapters.md
- OUTDATED L5-14, L128-140: "write a custom adapter" → no plug-in path (`adapters/index.ts:45` only accepts claude|codex|gemini).
- OUTDATED L11: one PTY adapter → composite of pty, tmux, codexAppServer routed by handle prefix; `ORC_SESSION_TRANSPORT`.
- OUTDATED L33: `getOutputTail(handle)` → `(handle, maxBytes?)`.
- OUTDATED L86-100: optional capabilities missing `inspectSession`, `survivesCoordinatorExit`, `capabilitiesFor`, `submit`, `onEvent`, `turnActive`.
- OUTDATED L113: Stop hook row omits the run guard (`stop_blocked`).
- DELETE L142-243: assertAdapterContract section and the 90-line HTTP adapter example.
- TRIM L37-84: → method table; L121-126 → 1 line. The hook→record table stays here (canonical).

## docs/getting-started.md
- OUTDATED L5: "no build step" → the package runs `dist/`.
- OUTDATED L44: "monitors heartbeats" → process probe.
- OUTDATED L117-123: bare `orc delegate` exits 1 → dispatch is automatic; `--task-ref` to force.
- DELETE L55-106 (spec example → link task-template.md), L158-166 (behind the scenes), L175-179 (See also).
- TRIM L18-28, L127-156: → 2 bullets; one commented code block.

## docs/testing.md
- OUTDATED L93: `singleFork` → `singleThread`.
- OUTDATED L118-120: timeouts → Claude 10 min/task, 25 overall; Codex 15/35; testTimeout 30 min.
- OUTDATED L65-69: missing `RUN_REAL_PROVIDERS_CODEX=1`.
- OUTDATED L13-22: missing `vitest.tmuxTmpdir.mjs` globalSetup, `vitest.integration.config.mjs` (no script); `npm test` runs `pretest` (tsc ×2 + eslint).
- DELETE L59-63, L82-88, L116-125, L146-169: repeats, auth, timeouts prose.
- TRIM L26-46, L96-108, L127-144: → table / 3 bullets / 2 lines. Add smoke usage from vnext-provider-protocols L20-28.

## docs/task-template.md
- OUTDATED L1-7: frontmatter missing `depends_on`, `required_provider`, `task_type`, `model`, `title`; `status:` is rejected on import (`lib/taskMarkdown.ts:22,113`).
- OUTDATED L11-12: prose "Depends on Task N-1" → only `depends_on:` is parsed.
- OUTDATED L44, L55, L77, L104, L106, L119: `.mjs`/`js` → `.ts`.
- OUTDATED L123: "before marking the task done" → workers never mark done.
- OUTDATED L143: "revert backlog.json from git; orc:doctor" → projection outside repo; `orc doctor`.
- TRIM L22-57, L69-132: → 3 headings, 1-line comments, 1 bash block.
- ADD: `## Acceptance criteria` is load-bearing (parsed, `lib/projectTaskStore.ts:327`).

## docs/plan-template.md
- OUTDATED L35: "numbered or `###` heading" → only `### Step N — Title` (`lib/planDocs.ts:43,211`).
- OUTDATED L38-39: backlog specs use prose deps → `depends_on:` frontmatter.
- TRIM L14-31: → 1-line comments. Absorb cli.md L249-273 (becomes canonical plan format).

## docker/dev/README.md
- OUTDATED L28-37: config.toml omits `model`, `model_reasoning_effort`.
- OUTDATED L42-56: entrypoint also writes `~/.claude/settings.json`.
- OUTDATED L83-89: `npm link` gives `orc` → needs `npm run build` first (bin is `dist/`).
- DELETE L39-40, L58-59 or L91-93, L110-117: filler / repeats.
- TRIM L3-26: → 4-row facts table; L42-56 → 1 line.

## docker/project/README.md
- OUTDATED L8-15: Start block omits `orc project add` + `orc init` (needed before the coordinator starts).
- TRIM L18-36, L47-84: → bullets / 2-row volume table / 3 steps.

## test-fixtures/README.md
- OUTDATED L29, L47, L55: `orchestrator/` prefix → repo root.
- OUTDATED L37: `fake-provider-cli.mjs` → `.ts`.
- OUTDATED L7-8: markers also print `FIXTURE_CWD`, `FIXTURE_STATE_DIR`.
- OUTDATED L39-58: integration config isn't wired to a script; `ORC_STRICT_PTY_TESTS`/`ORC_PTY_AVAILABLE` don't work (bug 4).
- TRIM L24-37: → 1 line. Optionally add a 1-line table of the other fixtures.

## agents/critic.md
- TRIM L16-27: "only the provided diff" (L24) contradicts "read AGENTS.md / adjacent docs" (L17-20) → pick one.
- TRIM L29-49: → 6 bullets; L53/L71 "silent/no preamble" once.
- DELETE L6-9: `models:` block isn't read by orc or Claude Code (all agent files).

## agents/integrator.md
- Same as critic (L16-26 contradiction, L47/L65 repeat, L6-9 `models:`). L28-43 overlaps critic → 5 bullets or merge.

## agents/reviewer.md
- OUTDATED L1-9: no `description:` (bug 3); `tools:` array vs string elsewhere.
- OUTDATED L30: hardcoded `/home/node/.npm-global/bin/orc` → `orc`; `<your_agent_id>` → the worker's agent_id.
- TRIM L27-32: duplicates the constraints the bootstrap injects.

## agents/state-auditor.md
- OUTDATED L19, L36-38: "backlog/runtime sync, Markdown-authoritative fields" → SQLite-only; check runtime.db vs projections.
- OUTDATED L34: "heartbeat" → lease auto-renewal, liveness probe, no-progress escalation.
- TRIM L49/L67: repeat.

## agents/task-auditor.md
- OUTDATED L3, L14: "backlog task specs" → SQLite tasks (`orc project task show|export`, `get_task`).
- TRIM L16-41: → 5 bullets; L45/L63 repeat.

## agents/test-runner.md
- OUTDATED L28-31: `npm test` already runs typecheck + lint (`pretest`).
- DELETE L32: nested `.worktrees` note.
- TRIM L14-21: → 4 bullets.

## skills/orc-commands/SKILL.md
- OUTDATED L29: "All Subcommands" misses sessions, run-close, terminal, review-*, pr-*, project, waiting-input, run-info, run-expire, events-filter, worker-status, stop-check.
- OUTDATED L38: blessed `orc delegate` → automatic dispatch.
- OUTDATED L57: only kill-all lacks a help guard → bug 1; also `--keep-sessions` is missing.
- OUTDATED L93: "PTY session" → tmux/PTY.
- OUTDATED L136-147: restart via `ps|grep coordinator.ts|kill` → kills every project's coordinator and misses `dist/coordinator.js` → `orc start-session` / recovery.md.
- OUTDATED L156: `run_work_complete` → `work_complete`.
- OUTDATED L154-162: state machine misses newer events; "idle timeout 30 min" → lease, auto-renewed.
- TRIM L23-46, L125-134: repeats → 1 line each.

## skills/worker-inspect/SKILL.md
- OUTDATED L29, L48-49: workview fields (`input_state`, `phase`, `finalization_*`) → only in `get_run` / `list_waiting_input`; workview has `current_activity`.
- OUTDATED L50, L52: lease timeout / heartbeat loop → immediate probe + requeue; no heartbeat loop.
- DELETE L51: unverifiable "press up" heuristic.
- TRIM L12-18: → 2 lines. ADD: `list_stalled_runs`, `orc sessions`, `orc attach`.

---

## Cross-file duplicates → canonical home

| topic | copies | keep in |
|-------|--------|---------|
| State dir file list | AGENTS, configuration L427-446, contracts L13-38, architecture L106-121, root contracts | docs/contracts.md |
| Task lifecycle / transitions | AGENTS L328+, configuration L59-70, contracts L99-147, global-project-contract L30-45, concepts, getting-started L158-166 | docs/contracts.md (use the global-project-contract table) |
| Liveness, lease, hook idle, no-progress | AGENTS L348-382, configuration L213-215, contracts L271-293/L513, root contracts | docs/contracts.md; configuration keeps keys/defaults |
| Session secret / operator token / control-API auth | configuration L32-35, cli L199-224/L318-368, global-project-contract L11, contracts L586-700 | docs/contracts.md |
| Project selection + data home | cli L10, configuration L7/L20/L24/L37-41, global-project-contract L9/L15 | docs/configuration.md |
| Settings precedence | configuration L3, L20, L137, L417-425 | configuration L417-425 |
| Execution modes | AGENTS L315-326, configuration L278-416 | docs/configuration.md |
| Command reference | AGENTS L213-281, skills/orc-commands, root contracts, cli.md | docs/cli.md; skill = short cheat-sheet |
| Worker phased workflow / review / PR loop | AGENTS L68-192, worker-bootstrap-v2 L60-199 | templates/worker-bootstrap-v2.txt |
| Scout lifecycle | AGENTS L386-437, master/scout templates | templates |
| Plan Markdown format | cli L249-273, plan-template L35-39, concepts L66-76 | docs/plan-template.md |
| Task spec example | getting-started L55-106, task-template | docs/task-template.md |
| Roles / two-root model | AGENTS, architecture L46-81/L125-138, concepts | docs/architecture.md |
| Adapter interface / hook records | adapters, root contracts L48-81, contracts L33-34 | docs/adapters.md (hooks table), contracts.md (file only) |
| Invariants | contracts L295-302 and L742-770, root contracts | contracts L742+ |
| Recovery vs troubleshooting (stale claims, orphan worktrees, kill-all) | troubleshooting, recovery, cli | recovery.md (one symptom table); kill-all flags in cli.md |
| Provider install/auth | troubleshooting L9-52, testing L77-88, getting-started | recovery.md table |
| Memory CLI/MCP reference | memory L136-335, cli L334-351, AGENTS | docs/cli.md; mcp/tools-list.ts |
| REVIEW_FINDINGS block | 5 agent files, bootstrap, AGENTS | agent files + bootstrap |

## Proposed structure

```
README.md                  what + install + 3-bullet how-it-works
AGENTS.md                  repo dev guide: stack, env, commit rules, pointers
CLAUDE.md                  @AGENTS.md
docs/getting-started.md    install → project add → start-session → first task
docs/cli.md                every command + flags (canonical)
docs/configuration.md      settings keys, env vars, selection, execution modes, runtimes
docs/contracts.md          state files, lifecycle, schemas (linked), events, control API/auth, invariants
docs/architecture.md       components, two roots, glossary
docs/adapters.md           adapter interface, hooks table
docs/memory.md             model table, auto-ingestion table
docs/recovery.md           symptom | check | fix (absorbs troubleshooting)
docs/testing.md            suites, env switches, real-provider + smoke
docs/task-template.md      task body format
docs/plan-template.md      plan format (canonical)
docker/{dev,project}/README.md, test-fixtures/README.md
agents/*.md, skills/*/SKILL.md
```
Deleted: `contracts.md` (root), `ORC_STATE_VNEXT_IMPLEMENTATION_BRIEF.md`, `docs/vnext-architecture.md`, `docs/vnext-provider-protocols.md`, `docs/concepts.md`, `docs/global-project-contract.md`, `docs/troubleshooting.md`.

Delete-time code touches: `lib/prompts.test.ts:145-159` (reads root contracts.md), comments in `adapters/runtime.ts:11`, `adapters/codexAppServer.ts:6`, the cli.md L368 anchor, and AGENTS' pointer to "docs/cli.md → Plans".
