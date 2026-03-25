---
ref: orc-warroom/50-orc-warroom-sprite-assets
feature: orc-warroom
priority: normal
status: todo
required_provider: codex
---

# Task 50 — Create orc pixel art sprite assets and async pre-loader

Depends on Task 49. Blocks Task 51.

## Scope

**In scope:**
- Create `assets/sprites/orc/` directory with PNG frame sets for 4 states: idle, work, done, fail
- Create `lib/tui/sprites.ts` — async pre-loader that reads all PNGs and renders them to terminal strings via `terminal-image`, caching results in a `Map`
- Add `"assets"` to `package.json` `"files"` array

**Out of scope:**
- Do not create any React components yet (that is Task 51)
- Do not wire sprites into any CLI command yet
- Do not use GIF or animated formats — static PNG frames only
- Do not add any new npm dependencies for image generation, conversion, or optimization

---

## Context

### Current state

No visual assets exist. `terminal-image@3.0.0` is installed (Task 49) but unused. React components will need to animate orc sprites by cycling pre-rendered frame strings — they cannot call async APIs inside a synchronous render.

### Desired state

`assets/sprites/orc/` contains PNG frame sets. `lib/tui/sprites.ts` exports `preloadSprites()` which resolves all frames to terminal-renderable strings before the ink app starts. Components receive a `Map<string, string>` and cycle frames synchronously.

The sprites are intentionally simple but recognizable: a green-skinned chibi orc with dark hair and small tusks. Visual fidelity is secondary to readability, consistency, and deterministic loading order.

### Start here

- `node_modules/terminal-image/` — understand the `buffer(data, options)` async API
- `package.json` — `"files"` array to add `"assets"` to

**Affected files:**
- `assets/sprites/orc/*.png` — new directory and files
- `lib/tui/sprites.ts` — new file
- `package.json` — add `"assets"` to `"files"`
- `package-lock.json` — if dependency metadata changes during implementation

---

## Goals

1. Must create PNG sprites for 4 states: `idle` (2 frames), `work` (3 frames), `done` (2 frames), `fail` (1 frame) — 8 files total.
2. Sprites must be 32×32 pixel art PNGs, optimized for small size, and ≤ 4KB each.
3. Must create `lib/tui/sprites.ts` exporting `preloadSprites(): Promise<SpriteMap>` where `SpriteMap = Map<string, string[]>` — keys are state names, values are arrays of pre-rendered strings.
4. `preloadSprites()` must resolve before any React render starts; it must never be called inside a component.
5. Must add `"assets"` to `package.json` `"files"` array.
6. Must preserve deterministic frame order: `idle-1` before `idle-2`, `work-1` before `work-2` before `work-3`, etc.
7. `preloadSprites()` must fail clearly if any declared frame file is missing or unreadable; it must not silently return partial state maps.
8. Must handle terminals without Kitty/sixel support (terminal-image falls back to Unicode block art automatically), but tests may use a narrow mock seam for `terminal-image` if CI behavior is unstable.

---

## Implementation

### Step 1 — Create sprite PNGs

Create pixel art at 32×32 in `assets/sprites/orc/`:
- `idle-1.png`, `idle-2.png` — orc sitting, blink cycle
- `work-1.png`, `work-2.png`, `work-3.png` — orc at keyboard, arms moving
- `done-1.png`, `done-2.png` — celebration, arms raised
- `fail-1.png` — face-down, X eyes

Art direction:
- green-skinned chibi orc
- dark hair and small tusks
- gray desk and small keyboard visible in the `work` frames
- simple, recognizable, low-detail pixel art preferred over polish

Implementation options:
- commit hand-authored PNGs directly, or
- generate placeholder PNGs programmatically using local tooling already present on the machine

`ffmpeg` may be used as an optional local tool for scripted generation, conversion, or optimization. It is not required.

Do not add any new npm dependencies for asset creation.

### Step 2 — Create `lib/tui/sprites.ts`

```typescript
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import terminalImage from 'terminal-image';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPRITES_DIR = join(__dirname, '../../assets/sprites/orc');

export type SpriteMap = Map<string, string[]>;

const FRAME_SETS: Record<string, string[]> = {
  idle: ['idle-1.png', 'idle-2.png'],
  work: ['work-1.png', 'work-2.png', 'work-3.png'],
  done: ['done-1.png', 'done-2.png'],
  fail: ['fail-1.png'],
};

export async function preloadSprites(): Promise<SpriteMap> {
  const map: SpriteMap = new Map();
  for (const [state, files] of Object.entries(FRAME_SETS)) {
    const frames = await Promise.all(
      files.map(async (f) => {
        const buf = await readFile(join(SPRITES_DIR, f));
        return terminalImage.buffer(buf, { width: 16, height: 16 });
      }),
    );
    map.set(state, frames);
  }
  return map;
}
```

Notes:
- Resolve sprite paths from `import.meta.url`; do not rely on process cwd.
- Keep `FRAME_SETS` as the canonical ordering source; do not derive frame order from directory iteration.
- If `terminal-image` proves unstable in unit tests, a narrow mock around the rendering call is acceptable.

### Step 3 — Add `"assets"` to `package.json` `"files"`

```json
"files": [
  "assets",
  ...existing entries...
]
```

---

## Acceptance criteria

- [ ] `assets/sprites/orc/` contains exactly 8 PNG files matching the naming convention.
- [ ] Each PNG is ≤ 4KB.
- [ ] `preloadSprites()` resolves to a `Map` with 4 keys: `idle`, `work`, `done`, `fail`.
- [ ] Each key maps to an array of non-empty strings (terminal-image output).
- [ ] Frame ordering is deterministic and follows the explicit `FRAME_SETS` declaration.
- [ ] `preloadSprites()` throws a clear error if any declared frame file is missing.
- [ ] `preloadSprites()` completes without error in a standard terminal environment.
- [ ] `package.json` `"files"` includes `"assets"`.
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

  it('all frames are non-empty strings', async () => {
    const map = await preloadSprites();
    for (const frames of map.values()) {
      for (const frame of frames) {
        expect(typeof frame).toBe('string');
        expect(frame.length).toBeGreaterThan(0);
      }
    }
  });

  it('preserves declared frame ordering', async () => {
    const map = await preloadSprites();
    expect(map.get('idle')!.length).toBe(2);
    expect(map.get('work')!.length).toBe(3);
  });
});
```

If CI/TTY behavior makes `terminal-image` unstable in tests, a narrow mock is acceptable. Do not broaden the seam beyond what is needed for deterministic unit coverage.

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

**Risk:** `terminal-image` may behave differently in headless/CI environments, and binary sprite creation can become a time sink if the worker over-invests in art polish.
**Rollback:** delete `assets/sprites/orc/` and `lib/tui/sprites.ts`; revert `package.json` `"files"`. No state files touched.
