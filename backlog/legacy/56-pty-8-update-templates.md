# Task 56 — Update Bootstrap Templates

No dependencies. Can be done at any point in the migration sequence.

---

## Scope

**In scope:**
- `templates/worker-bootstrap-v2.txt` — remove "tmux pane" reference
- `templates/master-bootstrap-v1.txt` — remove "tmux-backed" reference

**Out of scope:**
- `task-envelope-v2.txt` — already updated (no tmux references)
- All source `.mjs` files — do not touch
- Any other template or config file — do not touch

---

## Context

The two bootstrap templates are sent to agent CLI sessions at session start. They describe the agent's operating environment. Currently both reference tmux:

- `worker-bootstrap-v2.txt` line 5: `"You run as a CLI session in a tmux pane."`
- `master-bootstrap-v1.txt` line 54: `"You are running in a tmux-backed CLI session."`

After the pty migration, agents run as PTY child processes managed by the coordinator. The tmux references are inaccurate and should be updated to describe the new environment correctly.

No other content in these templates references tmux or needs to change.

**Affected files:**
- `templates/worker-bootstrap-v2.txt`
- `templates/master-bootstrap-v1.txt`

---

## Goals

1. Must update the worker bootstrap to say "PTY process" instead of "tmux pane".
2. Must update the master bootstrap to say "PTY-backed" instead of "tmux-backed".
3. No other content in either file must change.

---

## Implementation

### Step 1 — Update `templates/worker-bootstrap-v2.txt`

Find line 5:
```
You are an autonomous orchestration worker. You run as a CLI session in a tmux pane.
```

Replace with:
```
You are an autonomous orchestration worker. You run as a CLI session in a PTY process managed by the coordinator.
```

### Step 2 — Update `templates/master-bootstrap-v1.txt`

Find line 54:
```
You are running in a tmux-backed CLI session. Use orc CLI commands directly
```

Replace with:
```
You are running in a PTY-backed CLI session. Use orc CLI commands directly
```

---

## Acceptance criteria

- [ ] `worker-bootstrap-v2.txt` contains no occurrences of the word "tmux".
- [ ] `master-bootstrap-v1.txt` contains no occurrences of the word "tmux".
- [ ] No other lines in either file are modified.
- [ ] `grep -r "tmux" templates/` returns no matches.

---

## Tests

No new tests — these are text content files. The `templateRender.mjs` unit tests cover rendering correctness and do not need updating.

---

## Verification

```bash
grep -n "tmux" templates/worker-bootstrap-v2.txt
# Expected: no output

grep -n "tmux" templates/master-bootstrap-v1.txt
# Expected: no output
```
