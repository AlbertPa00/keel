---
name: node-api
description: Node REST API conventions — validate at the boundary, consistent error envelope, safe writes
---

# Node API Conventions

## Boundary validation

Parse every request body/query/params with a schema (zod, valibot) at the
route edge. Handlers receive typed, validated input — never `req.body` raw.
On failure return 400 with per-field messages.

## Error envelope

Every error response uses one shape so clients and agents can self-correct:

```json
{ "errorMessages": ["human readable summary"], "errors": { "field": "reason" } }
```

Field errors should include allowed values where they exist.

## Safe writes

- Mutating endpoints support `?dryRun=true` — validate and return a preview
  without persisting.
- Accept an `Idempotency-Key` header; replay with the same body returns the
  original response, with a different body returns 422.
- Destructive deletes are two-step: dry-run returns a `confirmToken`, the real
  delete requires it.

## Handler shape

Thin handlers: parse → authorize → call service → map result. No domain logic
in the route file.
