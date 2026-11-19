import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the bundled catalog directory.
 * - dist: <pkg>/dist/catalog/locate.js → <pkg>/packs
 * - src/vitest: <pkg>/src/catalog/locate.ts → <pkg>/packs
 * - override: KEEL_PACKS_DIR env wins (dev / custom catalogs)
 */
export function catalogRoot(): string {
  const override = process.env.KEEL_PACKS_DIR;
  if (override && existsSync(override)) return override;
  for (const candidate of [join(here, "..", "..", "packs"), join(here, "..", "packs")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`keel: catalog not found near ${here}; set KEEL_PACKS_DIR`);
}
