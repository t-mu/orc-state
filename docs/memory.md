# Memory

Persistent, searchable notes that survive worker sessions. Commands: [cli.md → Memory](./cli.md#memory); MCP tools (`memory_wake_up`, `memory_search` — without `query` it browses a wing/room —, `memory_store`, `memory_status`): `mcp/tools-list.ts`.

## Store

| Fact | Value |
|------|-------|
| File | `memory.db` in the project state directory (`lib/memoryStore.ts`) |
| Created by | `ensureStateInitialized`: `orc init`, `orc project add`, `orc start-session` |
| Missing store | `memory-status` / `memory-search` / `memory-wake-up` / `memory-record` print `Memory store not initialized (memory.db not found).`; auto-ingestion skips silently |
| Access | `orc` CLI or MCP only; never write the file |
| Row | one drawer: `wing`, `hall`, `room`, `content`, `importance` (1–10, default 5), `source_type`, `source_ref`, `agent_id`, `tags`, `created_at`, `expires_at` |
| Dedup | content hash: storing the same content returns the existing id |
| Search | FTS5 over content, tags, wing, hall, room; ranked `bm25 × importance/10` |
| Wake-up | highest importance first, then newest, grouped by wing/room, cut at `tokenBudget × 4` characters (MCP `tokenBudget`, CLI `--budget`; default 800) |
| Pruning | expired (`expires_at`) and over 200 drawers per room (lowest importance dropped); at coordinator start and every `coordinator.memory_prune_interval_ms` (1 h, [configuration.md](./configuration.md)) |
| Doctor | `orc doctor` prints `memory health: ok=<bool>` plus messages (missing tables, WAL over 50 MB) |

## Coordinates

| Level | Meaning | Values |
|-------|---------|--------|
| `wing` | feature: the task ref before `/` (`wingFromTaskRef`; no `/` → `general`) | `memory-quality`, … |
| `hall` | kind of knowledge | `patterns`, `decisions`, `errors`, `observations`, `outcomes`, `reviews` |
| `room` | topic, short hyphenated slug | `sqlite`, `lifecycle`, `task-completions`, … |

`memory-record` defaults: wing `general`, hall `default`, room `default`.

## Worker use

From `templates/worker-bootstrap-v2.txt` (non-fatal):

```bash
WING=$(echo "<task_ref>" | cut -d'/' -f1)
{{orc_bin}} memory-wake-up --wing="$WING" 2>/dev/null || true             # explore phase
{{orc_bin}} memory-search "<query>" --wing="$WING" 2>/dev/null || true    # targeted lookup
{{orc_bin}} memory-record --content="<text>" --wing="$WING" --hall=<category> --room=<topic>
```

Record non-obvious patterns, root causes, decisions, gotchas. Not what the code or AGENTS.md already says.

## Auto-ingestion

| Trigger | hall / room | Content | Importance |
|---------|-------------|---------|-----------:|
| `run_finished` | `outcomes` / `task-completions` | `Task <ref> completed by <agent> (run <run_id>)` | 5 |
| `run_failed` | `errors` / `run-failures` | `Task <ref> failed (run <run_id>): <reason>` | 8 |
| `orc review-submit --outcome=findings` | `reviews` / `review-findings` | the findings text | 6 |
| `orc run-input-respond` (not MCP `respond_input`) | `decisions` / `master-input` | `Q: <question>\nA: <response>` | 7 |

Wing is always the task's feature (`wingFromTaskRef`).
