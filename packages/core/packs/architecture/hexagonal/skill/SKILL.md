---
name: hexagonal-architecture
description: Ports and adapters — the domain owns its ports, adapters implement them, composition happens at the edge
---

# Hexagonal Architecture

The core (domain + use cases) owns interfaces called **ports**. Infrastructure
code implements them as **adapters**. Dependencies point inward.

## The three questions before writing code

1. Is this a business rule? → domain (pure, no I/O).
2. Is this orchestration (fetch-save-decide)? → application service, depend on
   a port you declare, not an implementation.
3. Does this touch a database, HTTP, filesystem, clock? → adapter, and it must
   implement a port the core declared.

## Composition root

Exactly one place wires adapters to ports — `main.ts`, a container module, or
per-handler factories. Adapters never appear in core imports.

## Enforcement

`node .keel/check-boundaries.mjs` rejects imports that point outward. Ports
live in the layer that consumes them — not in a shared `interfaces/` grab-bag.
