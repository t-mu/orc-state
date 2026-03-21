---
ref: api/rate-limiting-middleware
feature: api-rate-limiting
priority: normal
status: todo
---

# Task 26 — Add Per-User Rate Limiting Middleware to /api/v2

Independent.

## Scope

**In scope:**
- Sliding window rate limiter middleware (100 requests per minute per user)
- Apply middleware to all `/api/v2` routes
- Store counters in Redis with a 60-second TTL
- Return HTTP 429 with a `Retry-After` header when limit is exceeded

**Out of scope:**
- Changes to any non-`/api/v2` routes
- Rate limiting by IP address or API key (only per authenticated user)
- Redis connection setup or configuration changes beyond what the middleware requires
- Test coverage (covered in Task 27)

---

## Context

The `/api/v2` API endpoints currently have no request rate limiting. Any authenticated user can send an unlimited number of requests, which creates risk of resource exhaustion and abuse.

### Current state

All `/api/v2` endpoints accept requests without any rate limiting. There is no middleware enforcing a per-user request cap. No `429` response is ever returned by these routes.

### Desired state

Every request to `/api/v2` passes through a sliding window rate limiter. Each authenticated user is allowed at most 100 requests per 60-second window. Requests that exceed the limit receive a `429 Too Many Requests` response with a `Retry-After` header indicating when the window resets. Counters are stored in Redis with a 60-second TTL.

### Start here

- `src/api/v2/router.ts` — entry point for all `/api/v2` routes; middleware is applied here
- `src/middleware/` — directory for existing middleware; add the new rate limiter here
- `src/lib/redis.ts` — Redis client singleton used by other parts of the codebase

**Affected files:**
- `src/middleware/rateLimiter.ts` — new file; implements sliding window logic and Redis counter storage
- `src/api/v2/router.ts` — register the rate limiter middleware on all `/api/v2` routes

---

## Goals

1. Must implement a sliding window algorithm (not fixed window or token bucket).
2. Must store per-user counters in Redis with key `ratelimit:<userId>` and TTL of 60 seconds.
3. Must allow exactly 100 requests per user per 60-second window before rejecting.
4. Must return HTTP 429 with a `Retry-After` header (value in seconds until window resets) on rejection.
5. Must apply to every route under `/api/v2` with no route-level opt-outs.
6. Must not modify routes outside `/api/v2`.

---

## Implementation

### Step 1 — Implement the sliding window middleware

**File:** `src/middleware/rateLimiter.ts`

```ts
// New file
// Exports a single Express/Koa middleware function.
// Uses Redis ZADD + ZREMRANGEBYSCORE + ZCARD to implement sliding window.
// Key pattern: `ratelimit:<userId>`
// Window: 60_000 ms; limit: 100
// On exceed: res.set('Retry-After', secondsUntilReset).status(429).json({ error: 'Too Many Requests' })
```

### Step 2 — Register middleware on /api/v2 router

**File:** `src/api/v2/router.ts`

```ts
import { rateLimiter } from '../../middleware/rateLimiter';
// Apply before all route handlers:
router.use(rateLimiter);
```

---

## Acceptance criteria

- [ ] A user making 100 requests within 60 seconds receives 200 on the 100th request.
- [ ] The 101st request within the same window receives 429.
- [ ] The 429 response includes a `Retry-After` header with a positive integer value (seconds).
- [ ] After the window expires (60 s), the user can make requests again.
- [ ] Requests from different users do not share counters.
- [ ] No routes outside `/api/v2` are affected.
- [ ] No changes to files outside the stated scope.

---

## Tests

Covered in Task 27.

---

## Verification

```bash
npx vitest run src/middleware/rateLimiter.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Redis unavailability causes middleware to error and block all `/api/v2` requests if not handled gracefully. Ensure the middleware fails open (logs error, passes request through) when Redis is unreachable.
**Rollback:** Remove `router.use(rateLimiter)` from `src/api/v2/router.ts` and delete `src/middleware/rateLimiter.ts`.
