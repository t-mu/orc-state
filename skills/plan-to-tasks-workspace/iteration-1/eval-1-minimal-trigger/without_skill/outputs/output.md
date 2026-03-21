# Task Specs Created from Plan

Three backlog task specs were created from the plan. They are sequenced so that the middleware (Task 26) lands first, tests (Task 27) follow, and docs (Task 28) can be written in parallel with tests once the middleware exists.

---

## Task 26 — Add Per-User Rate Limiting Middleware to /api/v2

**File:** `backlog/26-rate-limiting-middleware.md`
**Ref:** `api/rate-limiting-middleware`
**Dependencies:** none

Implements the sliding window rate limiter middleware using Redis (ZADD/ZREMRANGEBYSCORE/ZCARD). Applies to all `/api/v2` routes. Returns 429 with `Retry-After` on limit exceeded. Key pattern `ratelimit:<userId>`, 60-second TTL, 100 req/min limit.

---

## Task 27 — Write Tests for Rate Limiter

**File:** `backlog/27-rate-limiting-tests.md`
**Ref:** `api/rate-limiting-tests`
**Dependencies:** Task 26

Unit tests mock Redis and verify sliding window logic (allow under limit, reject at 101, per-user isolation, Retry-After header). Integration tests use a real Redis instance and hit a real `/api/v2` route to confirm the 429 path end-to-end.

---

## Task 28 — Document Rate Limiting in OpenAPI Spec

**File:** `backlog/28-rate-limiting-docs.md`
**Ref:** `api/rate-limiting-docs`
**Dependencies:** Task 26

Adds a reusable `TooManyRequests` component to the OpenAPI spec, references it from every `/api/v2` operation, documents the `Retry-After` integer header, and adds a per-user rate limit note to the auth/security section. No implementation or test files are touched.

---

## Dependency graph

```
Task 26 (middleware)
  └── Task 27 (tests)
  └── Task 28 (docs)
```

Tasks 27 and 28 both depend on Task 26. Tasks 27 and 28 are independent of each other and can run in parallel.
