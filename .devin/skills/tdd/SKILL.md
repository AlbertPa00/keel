---
name: tdd
description: Red-green-refactor discipline — write the failing test, pass it minimally, then refactor
---

# TDD Discipline

## The loop

1. **Red** — write the smallest test that fails for the right reason. Run it;
   confirm it fails on the missing behavior, not a typo.
2. **Green** — write the minimum code that passes. Hard-coding is allowed if it
   buys information.
3. **Refactor** — only with green tests. Extract, rename, delete duplication.
   The test suite is the safety net, not the goal.

## Rules of thumb

- Bug fix = failing regression test first, always.
- Test behavior at the module's public API; never test internals.
- One assertion cluster per test. If a test needs "and" in its name, split it.
- When exploration is needed, spike throwaway code first — then TDD the real
  implementation.
