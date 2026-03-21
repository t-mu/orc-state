---
ref: general/27-write-rate-limiter-tests
feature: general
priority: normal
status: todo
---

# Task 27 — Write Tests for the Rate Limiter

Depends on Task 26. Blocks nothing.

## Scope

**In scope:**
- Unit tests for the sliding window rate limiting logic in `src/middleware/rateLimiter.ts` (Redis mocked)
- Integration tests verifying the 429 response and `Retry-After` header against a real Redis instance spun up by the test suite

**Out of scope:**
- Tests for any routes outside `/api/v2`
- Load or performance testing
- Modifying the rate limiter implementation (Task 26)
- API documentation updates (Task 28)

---

## Context

Task 26 introduces the rate limiter middleware, but ships without dedicated tests. This task closes that gap with both unit and integration coverage so the sliding window logic and HTTP contract are verified before the feature is considered done.

### Current state

No tests exist for `src/middleware/rateLimiter.ts`. The middleware is implemented but untested.

### Desired state

A unit test file mocks Redis and validates the counter increment, TTL assignment, pass-through, and 429 paths. An integration test file spins up a real Redis instance (via the test suite setup) and verifies the full 429 response including the `Retry-After` header.

### Start here

- `src/middleware/rateLimiter.ts` — the implementation under test (from Task 26)
- `src/routes/api/v2/index.ts` — where the middleware is wired (for integration test route setup)
- Existing test files in `src/middleware/` or `src/__tests__/` — follow the established pattern

**Affected files:**
- `src/middleware/rateLimiter.test.ts` — new unit test file (create)
- `src/__tests__/integration/rateLimiter.integration.test.ts` — new integration test file (create)

---

## Goals

1. Must have unit tests that cover the pass-through path (under limit), the 429 rejection path (over limit), and the TTL assignment on first request.
2. Must mock Redis in unit tests so they run without a real Redis instance.
3. Must have integration tests that hit a real Redis instance and verify HTTP 429 is returned with a `Retry-After` header when the limit is exceeded.
4. Must verify that a user making requests within the limit receives normal (non-429) responses in the integration tests.
5. Must not modify the rate limiter implementation or any file outside the test files.

---

## Implementation

### Step 1 — Write unit tests with mocked Redis

**File:** `src/middleware/rateLimiter.ts` (read only) and `src/middleware/rateLimiter.test.ts` (create)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rateLimiter } from './rateLimiter';

// Mock the redis client
vi.mock('../lib/redis', () => ({
  redis: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
  },
}));

import { redis } from '../lib/redis';

describe('rateLimiter middleware', () => {
  let req: any, res: any, next: any;

  beforeEach(() => {
    req = { user: { id: 'user-1' } };
    res = { set: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    next = vi.fn();
    vi.clearAllMocks();
  });

  it('calls next() when request count is within the limit', async () => {
    (redis.incr as any).mockResolvedValue(1);
    (redis.expire as any).mockResolvedValue(1);
    await rateLimiter(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('sets TTL on the first request (count === 1)', async () => {
    (redis.incr as any).mockResolvedValue(1);
    (redis.expire as any).mockResolvedValue(1);
    await rateLimiter(req, res, next);
    expect(redis.expire).toHaveBeenCalledWith(`rate:user-1`, 60);
  });

  it('does not set TTL on subsequent requests (count > 1)', async () => {
    (redis.incr as any).mockResolvedValue(50);
    await rateLimiter(req, res, next);
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After header when limit is exceeded', async () => {
    (redis.incr as any).mockResolvedValue(101);
    (redis.ttl as any).mockResolvedValue(30);
    await rateLimiter(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.set).toHaveBeenCalledWith('Retry-After', '30');
    expect(next).not.toHaveBeenCalled();
  });

  it('falls back to WINDOW_SECONDS for Retry-After when TTL is negative', async () => {
    (redis.incr as any).mockResolvedValue(101);
    (redis.ttl as any).mockResolvedValue(-1);
    await rateLimiter(req, res, next);
    expect(res.set).toHaveBeenCalledWith('Retry-After', '60');
  });
});
```

### Step 2 — Write integration tests against a real Redis instance

**File:** `src/__tests__/integration/rateLimiter.integration.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app'; // the Express app
import { redis } from '../../lib/redis';

describe('Rate limiter integration — /api/v2', () => {
  beforeAll(async () => {
    // Ensure Redis is reachable; the test suite bootstraps Redis via env/setup
    await redis.flushdb(); // clear any leftover keys
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('returns 200 for requests within the rate limit', async () => {
    const res = await request(app).get('/api/v2/health').set('x-user-id', 'test-user-1');
    expect(res.status).not.toBe(429);
  });

  it('returns 429 with Retry-After header after exceeding 100 requests', async () => {
    // Make 101 requests; the 101st must be rejected
    for (let i = 0; i < 100; i++) {
      await request(app).get('/api/v2/health').set('x-user-id', 'test-user-2');
    }
    const res = await request(app).get('/api/v2/health').set('x-user-id', 'test-user-2');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});
```

---

## Acceptance criteria

- [ ] Unit tests pass without a running Redis instance (fully mocked).
- [ ] Unit test covers the pass-through path (within limit).
- [ ] Unit test covers the 429 rejection path (over limit) and verifies `Retry-After` header value.
- [ ] Unit test covers TTL assignment on first request.
- [ ] Integration test verifies HTTP 200 for requests within the limit.
- [ ] Integration test verifies HTTP 429 with a positive-integer `Retry-After` header after the 101st request.
- [ ] No modifications to `src/middleware/rateLimiter.ts` or any file outside the stated test files.
- [ ] No changes to files outside the stated scope.

---

## Tests

Unit tests in `src/middleware/rateLimiter.test.ts` — see Implementation Step 1 for full `it(...)` shapes.

Integration tests in `src/__tests__/integration/rateLimiter.integration.test.ts` — see Implementation Step 2.

---

## Verification

```bash
# Unit tests only
npx vitest run src/middleware/rateLimiter.test.ts
```

```bash
# Integration tests (requires Redis — spun up by test suite)
npx vitest run src/__tests__/integration/rateLimiter.integration.test.ts
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm test
```
