---
description: "Layered Architecture (architecture/layered)"
trigger: glob
globs: ["src/**","apps/**","packages/**"]
---
Import direction is enforced mechanically by `node .keel/check-boundaries.mjs`.
Before adding an import across folders, check the layer map in AGENTS.md:
an inner layer must never import from an outer one, and a layer may only
import the layers it declares in `may_import`.
