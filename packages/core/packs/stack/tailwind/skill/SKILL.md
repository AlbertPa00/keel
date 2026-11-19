---
name: tailwind
description: Tailwind utility-first conventions — design tokens, responsive variants, when to extract components
---

# Tailwind Conventions

## Tokens over literals

Use theme tokens (`text-foreground`, `bg-muted`, `ring-primary`) instead of
arbitrary values (`text-[#3a3a3a]`). If a value repeats twice, it belongs in
the theme, not a bracket.

## Composition

- Layout classes on the parent (`flex`, `grid`, `gap-*`), sizing on the child.
- Interactive states as variants: `hover:`, `focus-visible:`, `disabled:`,
  `aria-expanded:` — never manual class toggling in JS.
- Merge conditional classes with a tiny `cx()`/`cn()` helper — no template
  strings inside className logic branches.

## When to extract

Three or more elements sharing the same class list → extract a component.
Never extract to `@apply` first; components are the abstraction, not CSS.

## Truncated/dynamic text

Anything `truncate`d or `line-clamp`ed must have a reveal path — `title`
attribute or expandable state.
