---
name: layered-architecture
description: Layered architecture — dependency direction, where new code belongs, and how the boundary check works
---

# Layered Architecture

Layers are ordered inner to outer. Code may only import from layers listed in
its `may_import` in `harness.yaml`. The canonical example:

```
domain  → (nothing)
application → domain
adapters → domain, application
```

## Where code belongs

- **domain**: entities, value objects, pure business rules. No I/O, no
  framework imports, no dates from `new Date()` — take them as parameters.
- **application**: use cases — orchestrate domain objects and ports. One file
  per use case.
- **adapters**: HTTP handlers, ORM repositories, external clients. Translate
  between the world and the application layer.

## The boundary check

`node .keel/check-boundaries.mjs` fails the build on a wrong-direction import.
If it flags you, the fix is usually to move the file or inject the dependency,
not to widen `may_import` — widening needs a human decision in `harness.yaml`.
