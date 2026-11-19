---
name: typescript-strict
description: Strict TypeScript idioms — narrowing, exhaustive handling, and type-level safety for everyday code
---

# TypeScript Strict Idioms

Write code that makes the compiler do the work.

## Narrowing over assertion

Never reach for `as` or `!` when a check exists. Narrow with discriminated
unions, `in` checks, and `instanceof`:

```ts
type Result = { ok: true; value: T } | { ok: false; error: string };
// res.ok ? res.value : res.error  — no assertion needed
```

## Exhaustiveness

Add a `never` check to every switch on a union so new variants break the build:

```ts
const unreachable = (x: never): never => { throw new Error(`unhandled: ${x}`); };
```

## Branded ids

Wrap raw strings/numbers for domain ids so they cannot be swapped:

```ts
type UserId = string & { readonly __brand: "UserId" };
```

## Ban list

- `any` — use `unknown` and narrow
- `as Foo` — use a type guard or `satisfies`
- non-null `!` — use optional chaining `?.` + explicit undefined handling
- `enum` — prefer `as const` objects or string unions
