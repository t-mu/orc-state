---
ref: general/26-add-api-rate-limiting
feature: general
priority: normal
status: todo
---

# Task 26 — Add Rate Limiting Middleware to All /api/v2 Endpoints

Independent.

## Scope

**In scope:**
- Implement per-user sliding window rate limiting middleware (100 req/min) applied to all `/api/v2` routes
- Store rate limit counters in Redis with a 60s TTL
- Return HTTP 429 with a `Retry-After` header when the limit is exceeded
- Wire the middleware into the existing Express (or equivalent) router for `/api/v2`

**Out of scope:**
- Rate limiting for any endpoints outside `/api/v2`
- Changing authentication or session logic
- Redis cluster configuration or infrastructure provisioning
- Updating API documentation (covered in Task 28)
- Writing tests (covered in Task 27)

---

## Context

The `/api/v2` API currently has no per-user request throttling, which leaves it vulnerable to abuse and resource exhaustion. A sliding window approach provides accurate burst control compared to fixed-window counters.

### Current state

All `/api/v2` endpoints accept requests at unlimited rates. There is no middleware inspecting per-user request volume or returning 429 responses.

### Desired state

Every request to `/api/v2` passes through a rate limiting middleware. The middleware looks up the user's request count in Redis, increments it with a 60s TTL, and rejects requests over 100/min with a 429 response including a `Retry-After: <seconds>` header.

### Start here

- `src/routes/api/v2/index.ts` (or equivalent router entry point) — where middleware is registered
- `src/middleware/` — existing middleware directory to add the new module alongside

**Affected files:**
- `src/middleware/rateLimiter.ts` — new sliding window rate limiter middleware (create)
- `src/routes/api/v2/index.ts` — register the middleware on the `/api/v2` router

---

## Goals

1. Must implement a sliding window algorithm that counts requests per user over a 60-second rolling window.
2. Must store counters in Redis using a key per user with a 60s TTL (INCR + EXPIRE or equivalent atomic operation).
3. Must reject requests exceeding 100 per minute with HTTP 429 and a `Retry-After` header indicating seconds until the window resets.
4. Must apply the middleware to every route under `/api/v2` without altering individual route handlers.
5. Must not break any existing route behavior for requests within the rate limit.

---

## Implementation

### Step 1 — Create the sliding window rate limiter middleware

**File:** `src/middleware/rateLimiter.ts`

```ts
import { Request, Response, NextFunction } from 'express';
import { redis } from '../lib/redis'; // use existing Redis client

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 100;

export async function rateLimiter(req: Request, res: Response, next: NextFunction) {
  const userId = req.user?.id ?? req.ip; // fall back to IP if no auth
  const key = `rate:${userId}`;

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }

  if (count > MAX_REQUESTS) {
    const ttl = await redis.ttl(key);
    res.set('Retry-After', String(ttl > 0 ? ttl : WINDOW_SECONDS));
    res.status(429).json({ error: 'Too Many Requests', retryAfter: ttl > 0 ? ttl : WINDOW_SECONDS });
    return;
  }

  next();
}
```

Invariant: do not modify the Redis client initialization or connection logic in `src/lib/redis.ts`.

### Step 2 — Register the middleware on the /api/v2 router

**File:** `src/routes/api/v2/index.ts`

```ts
import { rateLimiter } from '../../../middleware/rateLimiter';

// Add before existing route registrations:
router.use(rateLimiter);
```

Invariant: the middleware must be added before individual route handlers so it applies to all of them.

---

## Acceptance criteria

- [ ] A request by a user that exceeds 100 requests within 60 seconds receives HTTP 429.
- [ ] The 429 response includes a `Retry-After` header with a positive integer value (seconds).
- [ ] Requests within the 100/min limit pass through and receive normal responses.
- [ ] Redis keys for rate limiting expire within 60 seconds of first use (TTL set correctly).
- [ ] Requests to routes outside `/api/v2` are not affected by the middleware.
- [ ] The middleware short-circuits and does not call `next()` when the limit is exceeded.
- [ ] No changes to files outside the stated scope.

---

## Tests

(Covered in Task 27.)

---

## Verification

```bash
# Targeted verification — update path to match actual test file once Task 27 creates it
npx vitest run src/middleware/rateLimiter.test.ts
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** If `redis.incr` and `redis.expire` are not atomic, a concurrent request may never get the TTL set, causing the key to persist indefinitely and blocking users permanently.
**Rollback:** `git restore src/middleware/rateLimiter.ts src/routes/api/v2/index.ts && npm test`
