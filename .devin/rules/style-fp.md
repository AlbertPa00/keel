---
description: "Functional-First Style (style/fp-strict)"
trigger: glob
globs: ["**/*.ts","**/*.tsx"]
---
Functional style rules for this codebase:
- Guard clauses first; never nest past 2 levels — decompose instead.
- Functions do one thing; if it reads like two sentences, split it.
- Prefer map/filter/reduce and composition over loops and mutation.
- Domain code is pure: inject clock, random, and I/O as parameters.
- No obvious comments — name things instead.
