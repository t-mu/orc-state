---
ref: api/rate-limiting-tests
feature: api-rate-limiting
priority: normal
status: todo
---

# Task 27 — Write Tests for Rate Limiter

Depends on Task 26. Blocks Task 28.

## Scope

**In scope:**
- Unit tests for the sliding window logic in `src/middleware/rateLimiter.ts` (Redis mocked)
- Integration tests verifying the 429 response from `/api/v2` routes (real Redis instance)

**Out of scope:**
- Changes to the rate limiter implementation itself
- Tests for non-`/api/v2` routes
- Load or performance testing

---

## Context

Task 26 introduces a Redis-backed sliding window rate limiter. The logic needs unit coverage to verify correct counter behaviour without external dependencies, and integration coverage to verify the full HTTP 429 path end-to-end.

### Current state

No tests exist for the rate limiter because the middleware does not exist yet. After Task 26 lands, the code is untested.

### Desired state

A unit test file covers the sliding window algorithm in isolation with a mocked Redis client. A separate integration test file spins up a real Redis instance (via the test suite setup) and verifies that hitting the limit returns 429 with the correct headers.

### Start here

- `src/middleware/rateLimiter.ts` — the module under test (written in Task 26)
- `src/api/v2/router.ts` — entry point used in integration tests
- `test/setup.ts` — global test setup; check whether Redis spin-up helpers already exist

**Affected files:**
- `src/middleware/rateLimiter.test.ts` — new unit test file
- `test/integration/rateLimiter.integration.test.ts` — new integration test file

---

## Goals

1. Must have unit tests that mock Redis and verify the sliding window counter increments correctly.
2. Must have a unit test that verifies a request is rejected after 100 within the window.
3. Must have a unit test that verifies the counter resets after the TTL expires.
4. Must have integration tests that send 101 requests to a real `/api/v2` endpoint and assert the 101st returns 429.
5. Must assert the `Retry-After` header is present and a positive integer on 429 responses.
6. Must not modify the rate limiter implementation or any route handler.

---

## Implementation

### Step 1 — Unit tests with mocked Redis

**File:** `src/middleware/rateLimiter.test.ts`

```ts
// Mock the Redis client before importing rateLimiter.
// Test cases:
//   - first request allowed (counter = 1)
//   - 100th request allowed (counter = 100)
//   - 101st request rejected; next() not called; res.status(429) called
//   - Retry-After header set to a positive integer on rejection
//   - requests from two different users use separate keys
```

### Step 2 — Integration tests with real Redis

**File:** `test/integration/rateLimiter.integration.test.ts`

```ts
// Spin up real Redis (use existing test suite helper or docker-compose service).
// Send 100 requests as the same user to any /api/v2 route.
// Assert all 100 return 2xx.
// Send 101st request; assert 429 with Retry-After header.
// Verify a second user is not affected by the first user's counter.
```

---

## Acceptance criteria

- [ ] `npx vitest run src/middleware/rateLimiter.test.ts` passes with no real Redis dependency.
- [ ] `npx vitest run test/integration/rateLimiter.integration.test.ts` passes with a real Redis instance.
- [ ] Unit tests cover: allow under limit, reject at limit+1, Retry-After present, per-user isolation.
- [ ] Integration test confirms 429 on the 101st request in the same window.
- [ ] Integration test confirms `Retry-After` header is a positive integer.
- [ ] No changes to `src/middleware/rateLimiter.ts` or any route handler.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `src/middleware/rateLimiter.test.ts`:

```ts
it('allows the 100th request within the window', () => { ... });
it('rejects the 101st request with 429 and Retry-After', () => { ... });
it('uses separate counters for different users', () => { ... });
```

Add to `test/integration/rateLimiter.integration.test.ts`:

```ts
it('returns 429 after 100 requests in 60s window', async () => { ... });
it('includes a positive-integer Retry-After header on 429', async () => { ... });
```

---

## Verification

```bash
npx vitest run src/middleware/rateLimiter.test.ts
```

```bash
npx vitest run test/integration/rateLimiter.integration.test.ts
```

```bash
nvm use 24 && npm test
```
