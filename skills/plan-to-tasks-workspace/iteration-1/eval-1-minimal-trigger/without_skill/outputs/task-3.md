---
ref: api/rate-limiting-docs
feature: api-rate-limiting
priority: normal
status: todo
---

# Task 28 — Document Rate Limiting in OpenAPI Spec

Depends on Task 26.

## Scope

**In scope:**
- Add a `429` response object to all `/api/v2` endpoint definitions in the OpenAPI spec
- Add a `Retry-After` header description to the `429` response
- Add a note in the auth/security section explaining per-user rate limits (100 req/min)

**Out of scope:**
- Changes to the rate limiter implementation or tests
- Changes to non-`/api/v2` endpoint definitions
- Generating client SDKs or publishing the spec

---

## Context

Task 26 introduces per-user rate limiting on `/api/v2`. API consumers need to know that a 429 response is possible, what the limit is, and how to use the `Retry-After` header to back off correctly.

### Current state

The OpenAPI spec does not document a `429` response for any `/api/v2` endpoint. The auth section makes no mention of request rate limits. Clients have no visibility into the limit or retry guidance.

### Desired state

Every `/api/v2` endpoint in the OpenAPI spec includes a `429` response with the `Retry-After` header documented. The auth/security section contains a short explanation of the per-user 100 req/min limit and directs clients to read the `Retry-After` header on 429 responses.

### Start here

- `docs/openapi.yaml` (or `openapi.json`) — the OpenAPI spec file; all edits go here
- `docs/` — check for any partials or `$ref` files that define shared response objects

**Affected files:**
- `docs/openapi.yaml` — add `429` response object, `Retry-After` header, and auth section note

---

## Goals

1. Must add a reusable `429` response component (`components/responses/TooManyRequests`) with a `Retry-After` header.
2. Must reference that component from every `/api/v2` operation's `responses` block.
3. Must document `Retry-After` as an integer (seconds until window reset) in the response header definition.
4. Must add a rate-limit note to the auth/security section explaining the 100 req/min per-user limit.
5. Must not alter any existing response definitions (200, 400, 401, etc.).
6. Must not change endpoint definitions outside `/api/v2`.

---

## Implementation

### Step 1 — Add shared 429 response component

**File:** `docs/openapi.yaml`

```yaml
components:
  responses:
    TooManyRequests:
      description: Rate limit exceeded.
      headers:
        Retry-After:
          description: >
            Number of seconds to wait before retrying. Equals the remaining
            time in the current 60-second sliding window.
          schema:
            type: integer
            minimum: 1
      content:
        application/json:
          schema:
            type: object
            properties:
              error:
                type: string
                example: Too Many Requests
```

### Step 2 — Reference the component in each /api/v2 operation

**File:** `docs/openapi.yaml`

For every operation under `/api/v2`:

```yaml
      responses:
        # ... existing responses ...
        '429':
          $ref: '#/components/responses/TooManyRequests'
```

### Step 3 — Add rate limit note to auth section

**File:** `docs/openapi.yaml`

In the `info` description or the relevant security scheme description:

```yaml
# Add under the security scheme or info block:
# Rate limiting: Authenticated users are limited to 100 requests per 60-second
# sliding window per user. When the limit is exceeded, the API returns 429
# Too Many Requests. Read the Retry-After response header to determine how
# many seconds to wait before retrying.
```

---

## Acceptance criteria

- [ ] `docs/openapi.yaml` defines a `TooManyRequests` response component with a `Retry-After` integer header.
- [ ] Every `/api/v2` operation lists `'429': $ref: '#/components/responses/TooManyRequests'`.
- [ ] The auth or security section mentions the 100 req/min per-user limit and the `Retry-After` header.
- [ ] No existing response definitions (200, 400, 401, etc.) are altered.
- [ ] No endpoint definitions outside `/api/v2` are changed.
- [ ] The spec validates without errors (e.g. `npx @redocly/cli lint docs/openapi.yaml`).
- [ ] No changes to files outside the stated scope.

---

## Tests

No code tests required. Validate the spec with:

```bash
npx @redocly/cli lint docs/openapi.yaml
```

---

## Verification

```bash
npx @redocly/cli lint docs/openapi.yaml
# Expected: 0 errors, 0 warnings
```

```bash
nvm use 24 && npm test
```
