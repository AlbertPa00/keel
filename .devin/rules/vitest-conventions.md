---
description: "Vitest Conventions (stack/vitest)"
trigger: glob
globs: ["**/*.test.ts","**/*.test.tsx","**/*.spec.ts","tests/**"]
---
Vitest conventions:
- Co-locate unit tests next to the module (`foo.test.ts`); integration tests under `tests/`.
- One behavior per `it` — arrange / act / assert, no shared mutable fixtures.
- Mock at module boundaries (`vi.mock`), never patch internals.
- Deterministic: no real timers, clocks, or network. Use `vi.useFakeTimers` / fixtures.
