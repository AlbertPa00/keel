---
name: prisma
description: Prisma conventions — reversible migrations, transaction discipline, query shapes that avoid N+1
---

# Prisma Conventions

## Migrations

- Every schema change ships a named migration (`prisma migrate dev --name x`).
- Migrations must be reversible — no irreversible drops without an explicit
  data-loss note in the plan.
- Never `db push` or `migrate reset` against shared/dev databases.

## Transactions

Any request that writes more than one row, or writes plus reads that must be
consistent, uses `prisma.$transaction`. Prefer interactive transactions with
explicit ordering over `transactional: true` magic.

## Queries

- Fetch related rows via `include`/`select` — never per-row queries in a loop.
- Select only needed columns on list endpoints.
- Unique-violation retries: catch `P2002` and map to a 409 domain error, not a
  500.

## Access pattern

Services own Prisma calls. Route handlers and UI code never import `@prisma/client`.
