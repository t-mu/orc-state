---
ref: general/28-update-api-docs-rate-limiting
feature: general
priority: normal
status: todo
depends_on:
  - general/26-add-api-rate-limiting
---

# Task 28 — Update OpenAPI Spec with Rate Limiting Documentation

Depends on Task 26.

## Scope

**In scope:**
- Add a `429` response object to the OpenAPI spec for all `/api/v2` endpoints
- Document the `Retry-After` response header in the 429 response definition
- Add a note in the auth section (or a top-level API description) explaining per-user rate limits (100 req/min sliding window)

**Out of scope:**
- Changes to the rate limiter implementation (Task 26)
- Changes to tests (Task 27)
- Adding or removing any API endpoints
- Modifying any non-documentation source files

---

## Context

Task 26 adds per-user rate limiting with a 429 response and `Retry-After` header to all `/api/v2` endpoints. Without documentation, API consumers have no way to know that rate limiting exists, what the limit is, or how to interpret the `Retry-After` header.

### Current state

The OpenAPI spec for `/api/v2` endpoints does not include a `429` response object. The auth/general section contains no mention of rate limiting or per-user quotas.

### Desired state

Every `/api/v2` endpoint in the OpenAPI spec lists a `429` response with the `Retry-After` header documented. A note in the auth section (or equivalent top-level description) explains the 100 requests/minute per-user sliding window limit.

### Start here

- `openapi.yaml` (or `openapi.json`) — the root OpenAPI spec file; locate the `/api/v2` path entries and the auth/security section

**Affected files:**
- `openapi.yaml` (or `openapi.json`) — add `429` responses and rate limit note

---

## Goals

1. Must add a reusable `429` response component (or inline definition) that includes the `Retry-After` header with its description.
2. Must reference the `429` response on every `/api/v2` path operation in the spec.
3. Must add a human-readable note explaining the per-user rate limit (100 req/min, sliding window) in the auth section or a top-level `info.description` extension.
4. Must not alter any existing response definitions, path parameters, or security schemes beyond the additions listed above.
5. Must produce a valid OpenAPI document (passes schema validation after the edit).

---

## Implementation

### Step 1 — Add a reusable 429 response component

**File:** `openapi.yaml`

Add under `components.responses`:

```yaml
components:
  responses:
    TooManyRequests:
      description: Rate limit exceeded. Retry after the indicated number of seconds.
      headers:
        Retry-After:
          description: Number of seconds to wait before retrying.
          schema:
            type: integer
            example: 30
      content:
        application/json:
          schema:
            type: object
            properties:
              error:
                type: string
                example: Too Many Requests
              retryAfter:
                type: integer
                example: 30
```

### Step 2 — Reference the 429 response on every /api/v2 operation

**File:** `openapi.yaml`

For each operation under `/api/v2/...` paths, add:

```yaml
      responses:
        # ... existing responses ...
        '429':
          $ref: '#/components/responses/TooManyRequests'
```

Invariant: do not remove or modify existing `200`, `400`, `401`, `404`, or `500` response entries.

### Step 3 — Add a rate limiting note to the auth/info section

**File:** `openapi.yaml`

Add to the `info.description` field (or extend the auth section description):

```yaml
info:
  description: |
    ...existing description...

    ## Rate Limiting

    All `/api/v2` endpoints enforce a per-user sliding window rate limit of
    **100 requests per minute**. When the limit is exceeded, the API returns
    HTTP 429 with a `Retry-After` header indicating how many seconds to wait
    before retrying. Limits are tracked per authenticated user.
```

---

## Acceptance criteria

- [ ] A `TooManyRequests` (or equivalent) reusable response component exists in `components.responses` with a `Retry-After` header definition.
- [ ] Every `/api/v2` path operation in the spec references the `429` response.
- [ ] The `Retry-After` header is described as an integer indicating seconds to wait.
- [ ] The auth section or `info.description` contains a note about the 100 req/min per-user sliding window limit.
- [ ] No existing response definitions, path parameters, or security scheme entries are removed or altered.
- [ ] The OpenAPI spec remains valid (can be parsed by an OpenAPI validator without errors).
- [ ] No changes to files outside the stated scope.

---

## Tests

No automated tests — this is a documentation-only change. Manual verification via an OpenAPI validator is sufficient (see Verification).

---

## Verification

```bash
# Validate the OpenAPI spec is well-formed after edits
# (use whichever validator is available in this repo)
npx @redocly/cli lint openapi.yaml
# or: npx swagger-cli validate openapi.yaml
# Expected: exits 0 with no errors
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm test
```
