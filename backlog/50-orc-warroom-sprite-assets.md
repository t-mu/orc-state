---
ref: orc-warroom/50-orc-warroom-sprite-assets
feature: orc-warroom
priority: normal
status: done
required_provider: codex
---

# Task 50 — Create terminal-rendered orc sprite frames and async pre-loader

Depends on Task 49. Blocks Task 51.

## Scope

**In scope:**
- Create `lib/tui/sprites.ts` — async pre-loader that resolves checked-in text-grid sprite frames into terminal-renderable strings, caching results in a `Map`

**Out of scope:**
- Do not create any React components yet (that is Task 51)
- Do not wire sprites into any CLI command yet
- Do not add any new npm dependencies for sprite rendering

---

## Context

### Current state

No TUI sprite definitions exist yet. React components will need to animate orc sprites by cycling pre-rendered frame strings — they cannot call async APIs inside a synchronous render.

### Desired state

`lib/tui/sprites.ts` contains checked-in frame definitions for each orc state and exports `preloadSprites()` which resolves them into terminal-renderable strings before the Ink app starts. Components receive a `Map<string, string[]>` and cycle frames synchronously.

The sprites are intentionally simple but recognizable: a green-skinned chibi orc with dark hair and small tusks. Visual fidelity is secondary to readability, consistency, deterministic loading order, and ease of maintaining the frames directly in source.

### Start here

- `lib/banner.ts` — example of ANSI-colored text rendering already used in terminal output

**Affected files:**
- `lib/tui/sprites.ts` — new file
- `package.json` / `package-lock.json` — only if dependency cleanup is required

---

## Goals

1. Must define sprite frames for 4 states: `idle` (2 frames), `work` (3 frames), `done` (2 frames), `fail` (1 frame) — 8 frames total.
2. Frames must be maintained as checked-in text grids in source, not PNG assets or generated binary files.
3. Must create `lib/tui/sprites.ts` exporting `preloadSprites(): Promise<SpriteMap>` where `SpriteMap = Map<string, string[]>` — keys are state names, values are arrays of rendered multiline strings.
4. `preloadSprites()` must resolve before any React render starts; it must never be called inside a component.
5. Must preserve deterministic frame order: `idle-1` before `idle-2`, `work-1` before `work-2` before `work-3`, etc.
6. The rendering path must use a small symbol-to-color mapping from source-controlled frame definitions, not external image tooling.
7. `preloadSprites()` must fail clearly if any frame definition contains an unknown palette token; it must not silently return partial state maps.

---

## Implementation

### Step 1 — Define sprite frames in source

Create terminal-friendly pixel-art frame definitions for:
- `idle-1`, `idle-2` — orc sitting, blink cycle
- `work-1`, `work-2`, `work-3` — orc at keyboard, arms moving
- `done-1`, `done-2` — celebration, arms raised
- `fail-1` — face-down, X eyes

Art direction:
- green-skinned chibi orc
- dark hair and small tusks
- gray desk and small keyboard visible in the `work` frames
- simple, recognizable, low-detail pixel art preferred over polish

Use a small character palette, for example:
- `.` transparent / space
- `G` green skin
- `K` dark hair
- `T` tusk / tooth
- `D` desk
- `Y` keyboard
- `R` red / alert eye

The final rendered output may use ANSI-colored block characters or other compact terminal glyphs.

### Step 2 — Create `lib/tui/sprites.ts`

```typescript
export type SpriteMap = Map<string, string[]>;

export async function preloadSprites(): Promise<SpriteMap> {
  // resolve source-controlled frame definitions into colored multiline strings
}
```

Notes:
- Keep `FRAME_SETS` as the canonical ordering source; do not derive frame order from object enumeration side effects.
- Keep the palette and frame definitions easy to edit directly in source.
- If the renderer uses ANSI strings, tests may assert structure/content without snapshotting the full art.

---

## Acceptance criteria

- [ ] `preloadSprites()` resolves to a `Map` with 4 keys: `idle`, `work`, `done`, `fail`.
- [ ] Each key maps to an array of non-empty strings.
- [ ] Frame ordering is deterministic and follows the explicit `FRAME_SETS` declaration.
- [ ] `preloadSprites()` throws a clear error if any declared frame contains an unknown palette token.
- [ ] `npm test` passes with zero failures.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/tui/sprites.test.ts` (new file):

```typescript
import { describe, it, expect } from 'vitest';
import { preloadSprites } from './sprites.js';

describe('preloadSprites', () => {
  it('loads all four states', async () => {
    const map = await preloadSprites();
    expect(map.has('idle')).toBe(true);
    expect(map.has('work')).toBe(true);
    expect(map.has('done')).toBe(true);
    expect(map.has('fail')).toBe(true);
  });

  it('idle has 2 frames, work has 3, done has 2, fail has 1', async () => {
    const map = await preloadSprites();
    expect(map.get('idle')!.length).toBe(2);
    expect(map.get('work')!.length).toBe(3);
    expect(map.get('done')!.length).toBe(2);
    expect(map.get('fail')!.length).toBe(1);
  });
});
```

Add one failure-path test for an unknown palette token in a frame definition.

---

## Verification

```bash
npx vitest run lib/tui/sprites.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** source-controlled sprite grids can become unreadable if the palette grows too large.
**Rollback:** revert `lib/tui/sprites.ts` frame definitions. No state files touched.
