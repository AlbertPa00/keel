---
name: react-composition
description: React composition patterns — avoid prop-drilling and boolean-prop proliferation with slots, render props, and server/client boundaries
---

# React Composition Patterns

## Prefer composition to configuration

A component that takes `variant`, `isCompact`, `hideHeader`, `showFooter`
already has a bug. Expose slots instead:

```tsx
// bad: <Card variant="compact" hideHeader />
// good:
<Card>
  <Card.Body>{content}</Card.Body>
</Card>
```

## Lift state to the closest common owner

State belongs at the lowest component that needs it — never a global store by
default. When two siblings need it, lift to their parent, not to context.

## Server/client boundary (React 19 / RSC)

- Keep data-fetching in server components; pass serializable props down.
- Mark client leaves with `"use client"` at the leaf, not the root.
- Never pass functions or class instances across the boundary.

## Rules

- Function components only. No class components, no `defaultProps`.
- One component per file; file name = component name.
- Derived values: compute during render or `useMemo` only when measured.
- Effects are for synchronization with external systems — not for derived state.
