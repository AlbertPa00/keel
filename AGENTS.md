# AGENTS.md — keel

Deterministic agent-harness compiler (`packages/core`, `packages/cli`, `packages/mcp`).

## Commands

- Build all packages: `pnpm -r build`
- Typecheck (strict): `pnpm -r exec tsc --noEmit`
- Lint (zero warnings): `pnpm lint`
- Test suite: `pnpm test`
- Full verification gate: `node .keel/verify.mjs`

## Conventions

- ESM (`"type": "module"`) — internal TypeScript imports always use `.js` extensions.
- No LLM or network calls inside `@keel/core` compilation paths; same `harness.yaml` + catalog must produce byte-identical output.
- Never overwrite user content outside managed blocks or inverse-merge journals.

<!-- keel:begin -->
## Keel Harness — generated; edit `harness.yaml` then `keel apply`

- Stack: typescript · pnpm · vitest, zod
- Architecture: layered — `util→∅, domain→util, compiler→util+domain, surfaces→util+domain+compiler` (→ = may import)
- Verify before finishing: `pnpm -r exec tsc --noEmit && pnpm lint && pnpm test`
- Validate all external input at the boundary with schemas; infer types, never duplicate them
- Style: functional-first — guard clauses + early returns, max 2 nesting levels, declarative map/filter/reduce
- Before finishing: run `node .keel/verify.mjs` — fix failures yourself; the Stop hook enforces it
- Comments: minimal — name things, don't narrate
- Installed skills: typescript-strict, layered, tdd — invoke by name when the task matches
<!-- keel:end -->
