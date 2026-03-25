---
ref: orc-warroom/50-orc-warroom-sprite-assets
feature: orc-warroom
priority: normal
status: todo
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

---

## Context

### Current state

No visual assets exist. `terminal-image@3.0.0` is installed (Task 49) but unused. React components will need to animate orc sprites by cycling pre-rendered frame strings — they cannot call async APIs inside a synchronous render.

### Desired state

`assets/sprites/orc/` contains PNG frame sets. `lib/tui/sprites.ts` exports `preloadSprites()` which resolves all frames to terminal-renderable strings before the ink app starts. Components receive a `Map<string, string>` and cycle frames synchronously.

### Start here

- `node_modules/terminal-image/` — understand the `buffer(data, options)` async API
- `package.json` — `"files"` array to add `"assets"` to

**Affected files:**
- `assets/sprites/orc/*.png` — new directory and files
- `lib/tui/sprites.ts` — new file
- `package.json` — add `"assets"` to `"files"`

---

## Goals

1. Must create PNG sprites for 4 states: `idle` (2 frames), `work` (3 frames), `done` (2 frames), `fail` (1 frame) — 8 files total.
2. Sprites must be 32×32 pixel art, indexed PNG, <4KB each.
3. Must create `lib/tui/sprites.ts` exporting `preloadSprites(): Promise<SpriteMap>` where `SpriteMap = Map<string, string[]>` — keys are state names, values are arrays of pre-rendered strings.
4. `preloadSprites()` must resolve before any React render starts; it must never be called inside a component.
5. Must add `"assets"` to `package.json` `"files"` array.
6. Must handle terminals without Kitty/sixel support (terminal-image falls back to Unicode block art automatically).

---

## Implementation

### Step 1 — Create sprite PNGs

Create pixel art at 32×32 in `assets/sprites/orc/`:
- `idle-1.png`, `idle-2.png` — orc sitting, eye-blink cycle
- `work-1.png`, `work-2.png`, `work-3.png` — orc at keyboard, arms moving
- `done-1.png`, `done-2.png` — orc arms raised celebrating
- `fail-1.png` — orc face-down, X eyes

Use any pixel art editor (Aseprite, Libresprite, etc.) or generate programmatically.
Keep palette to 16 colors max. Export as indexed PNG.

### Step 2 — Create `lib/tui/sprites.ts`

```typescript
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
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
      })
    );
    map.set(state, frames);
  }
  return map;
}
```

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
});
```

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

**Risk:** `terminal-image` may fail in headless/CI environments without terminal support. The test should pass regardless since `terminal-image` falls back to Unicode block output.
**Rollback:** delete `assets/sprites/orc/` and `lib/tui/sprites.ts`; revert `package.json` `"files"`. No state files touched.
