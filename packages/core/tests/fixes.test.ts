import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { apply, catalogRoot, check, loadCatalog, remove } from "../src/index.js";
import { parseSpec } from "../src/spec/load.js";
import { tasteSchema } from "../src/spec/schema.js";

let dir: string;
const write = (rel: string, content: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), content, "utf8");
};
const read = (rel: string) => readFileSync(join(dir, rel), "utf8");

const SPEC_BOTH = `version: 1
targets: [devin, claude]
architecture:
  style: layered
  layers:
    - name: domain
      paths: ["src/domain/**"]
    - name: application
      paths: ["src/application/**"]
      may_import: [domain]
    - name: adapters
      paths: ["src/adapters/**"]
      may_import: [domain, application]
autonomy:
  verify: 'node -e "0"'
packs:
  include: [architecture/layered]
`;

describe("B1: stale-restore — removing a target restores user files, never deletes", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "keel-stale-"));
    write("package.json", JSON.stringify({ name: "fx", scripts: {} }));
    // Pre-existing user files BEFORE keel ever ran → created=false in the lockfile
    write("CLAUDE.md", "# My Claude notes\n\nuser content\n");
    write(".claude/settings.json", JSON.stringify({ permissions: { allow: ["Bash(mycmd:*)"] }, hooks: {} }, null, 2));
    write(".devin/config.json", JSON.stringify({ permissions: { allow: ["Write(.env*)"] } }, null, 2));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("apply with both targets merges into user files", () => {
    apply(dir, parseSpec(SPEC_BOTH));
    expect(read("CLAUDE.md")).toContain("user content");
    const cfg = JSON.parse(read(".devin/config.json"));
    // read_config_from guard written (B2)
    expect(cfg.read_config_from.claude).toBe(false);
    // user allow was evicted by keel deny (M4)
    expect(cfg.permissions.allow).not.toContain("Write(.env*)");
    expect(cfg.permissions.deny).toContain("Write(.env*)");
  });

  it("dropping the claude target restores pre-existing files instead of deleting them", () => {
    const devinOnly = parseSpec(SPEC_BOTH.replace("targets: [devin, claude]", "targets: [devin]"));
    const res = apply(dir, devinOnly);
    expect(res.plan.errors).toEqual([]);

    // CLAUDE.md was created=false → managed block stripped, user content kept
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    expect(read("CLAUDE.md")).not.toContain("keel:begin");
    expect(read("CLAUDE.md")).toContain("user content");

    // .claude/settings.json restored: keel permissions/hooks stripped, user entries kept
    const claude = JSON.parse(read(".claude/settings.json"));
    expect(claude.permissions.allow).toContain("Bash(mycmd:*)");
    expect(claude.permissions.deny).toBeUndefined();
    expect(JSON.stringify(claude.hooks ?? {})).not.toContain("stop-verify");

    // created=true files (skills) are deleted
    expect(existsSync(join(dir, ".claude/skills/layered"))).toBe(false);
  });

  it("remove restores the deny-evicted user allow and drops read_config_from", () => {
    remove(dir);
    const cfg = JSON.parse(read(".devin/config.json"));
    expect(cfg.permissions.allow).toContain("Write(.env*)");
    expect(cfg.read_config_from).toBeUndefined();
    expect(existsSync(join(dir, ".keel"))).toBe(false);
  });
});

describe("M6: check reports spec staleness", () => {
  it("fails when harness.yaml changed after last apply", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "keel-stale-spec-"));
    try {
      write2(dir2, "package.json", JSON.stringify({ name: "fx" }));
      write2(dir2, "harness.yaml", 'version: 1\nautonomy: { verify: "node -e \\"0\\"" }\n');
      const specA = parseSpec('version: 1\nautonomy: { verify: "node -e \\"0\\"" }\n');
      apply(dir2, specA);
      expect(check(dir2, specA).ok).toBe(true);
      const specB = parseSpec('version: 1\nautonomy: { verify: "node -e \\"1\\"" }\n');
      const res = check(dir2, specB);
      expect(res.ok).toBe(false);
      expect(res.spec_stale).toBe(true);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
const write2 = (dir: string, rel: string, content: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), content, "utf8");
};

describe("M5: taste profile validation", () => {
  it("rejects unknown enum values", () => {
    expect(tasteSchema.safeParse({ paradigm: "functional" }).success).toBe(false);
    expect(tasteSchema.safeParse({ paradigm: "fp", max_nesting: 2 }).success).toBe(true);
  });
});

describe("Polish 3: pack violation fixtures actually trip the boundary gate", () => {
  const catalog = loadCatalog(catalogRoot());

  for (const packId of ["architecture/layered", "architecture/hexagonal"]) {
    it(`${packId} fixtures: compliant passes, violating fails`, () => {
      const pack = catalog.get(packId)!;
      const fx = mkdtempSync(join(tmpdir(), "keel-fx-"));
      try {
        mkdirSync(join(fx, ".keel"), { recursive: true });
        write2(fx, "package.json", JSON.stringify({ name: "fx" }));
        write2(
          fx,
          ".keel/harness.json",
          JSON.stringify({
            boundaries: {
              layers: [
                { name: "domain", paths: ["src/domain/**"], may_import: [] },
                { name: "application", paths: ["src/application/**"], may_import: ["domain"] },
                { name: "adapters", paths: ["src/adapters/**"], may_import: ["domain", "application"] },
              ],
            },
          }),
        );
        const script = join(fx, ".keel", "check-boundaries.mjs");
        // stub targets the fixtures reference
        write2(fx, "src/domain/order.ts", "export interface Order { id: string }\nexport interface User { id: string }\n");
        write2(fx, "src/domain/user.ts", "export interface User { id: string }\n");
        write2(fx, "src/adapters/db/client.ts", "export const prisma = {};\n");
        write2(fx, "src/adapters/out/postgres-user-repo.ts", "export class PostgresUserRepo {}\n");

        // place fixtures where their relative imports resolve inside the layers
        const place = (name: string, dest: string) =>
          write2(fx, dest, readFileSync(join(pack.dir, "fixtures", name), "utf8"));

        if (packId === "architecture/layered") {
          place("compliant.ts", "src/application/svc.ts");
          place("violating.ts", "src/domain/sub/store.ts");
        } else {
          place("compliant.ts", "src/application/svc.ts");
          place("violating.ts", "src/application/sub/svc.ts");
        }

        // use the real emitted script from a scratch apply
        const dir3 = mkdtempSync(join(tmpdir(), "keel-script-"));
        write2(dir3, "package.json", JSON.stringify({ name: "fx" }));
        apply(
          dir3,
          parseSpec(
            'version: 1\narchitecture:\n  layers:\n    - { name: domain, paths: ["src/domain/**"] }\n    - { name: adapters, paths: ["src/adapters/**"], may_import: [domain] }\nautonomy: { verify: "node -e \\"0\\"" }\n',
          ),
        );
        writeFileSync(script, readFileSync(join(dir3, ".keel/check-boundaries.mjs"), "utf8"));
        rmSync(dir3, { recursive: true, force: true });

        const violating = spawnSync(process.execPath, [script], { cwd: fx, encoding: "utf8" });
        expect(violating.status).toBe(1);
        expect(violating.stderr + violating.stdout).toMatch(/cannot import/);

        // remove the violating fixture → gate passes
        rmSync(join(fx, packId === "architecture/layered" ? "src/domain/sub/store.ts" : "src/application/sub/svc.ts"));
        const ok = spawnSync(process.execPath, [script], { cwd: fx, encoding: "utf8" });
        expect(ok.status).toBe(0);
      } finally {
        rmSync(fx, { recursive: true, force: true });
      }
    });
  }
});

describe("M3: boundary checker ignores comments and string literals", () => {
  it("commented-out and template-literal imports do not trip the gate", () => {
    const dir5 = mkdtempSync(join(tmpdir(), "keel-mask-"));
    try {
      write2(dir5, "package.json", JSON.stringify({ name: "fx" }));
      apply(
        dir5,
        parseSpec(
          'version: 1\narchitecture:\n  layers:\n    - { name: domain, paths: ["src/domain/**"] }\n    - { name: adapters, paths: ["src/adapters/**"], may_import: [domain] }\nautonomy: { verify: "node -e \\"0\\"" }\n',
        ),
      );
      write2(
        dir5,
        "src/domain/store.ts",
        [
          '// import { prisma } from "../../adapters/db/client.js";  // commented violation',
          "/* import { x } from '../../adapters/db/client.js' */      // block-comment violation",
          "const doc = `import { y } from '../../adapters/db/client.js'`; // string violation",
          "export const ok = true;",
        ].join("\n"),
      );
      const res = spawnSync(process.execPath, [".keel/check-boundaries.mjs"], { cwd: dir5, encoding: "utf8" });
      expect(res.status).toBe(0);
    } finally {
      rmSync(dir5, { recursive: true, force: true });
    }
  });
});

describe("R1: boundary exceptions (ratchet) honor known-debt files only", () => {
  it("an excepted file passes; a new violation still fails", () => {
    const dir6 = mkdtempSync(join(tmpdir(), "keel-ratchet-"));
    try {
      write2(dir6, "package.json", JSON.stringify({ name: "fx" }));
      apply(
        dir6,
        parseSpec(`version: 1
architecture:
  layers:
    - { name: domain, paths: ["src/domain/**"] }
    - { name: adapters, paths: ["src/adapters/**"], may_import: [domain] }
  exceptions:
    - file: src/domain/legacy.ts
      allow: [adapters]
autonomy: { verify: "node -e \\"0\\"" }
`),
      );
      write2(dir6, "src/adapters/db.ts", "export const db = 1;\n");
      write2(dir6, "src/domain/legacy.ts", 'import { db } from "../adapters/db.js";\nexport const x = db;\n');
      // excepted file → gate green
      expect(spawnSync(process.execPath, [".keel/check-boundaries.mjs"], { cwd: dir6, encoding: "utf8" }).status).toBe(0);
      // a DIFFERENT violating file → still fails (the ratchet is not a leak)
      write2(dir6, "src/domain/newdebt.ts", 'import { db } from "../adapters/db.js";\nexport const y = db;\n');
      const res = spawnSync(process.execPath, [".keel/check-boundaries.mjs"], { cwd: dir6, encoding: "utf8" });
      expect(res.status).toBe(1);
      expect(res.stderr + res.stdout).toMatch(/newdebt.*domain.*cannot import.*adapters/);
    } finally {
      rmSync(dir6, { recursive: true, force: true });
    }
  });
});

describe("M1: safety.profile differentiates the baseline", () => {
  it("minimal profile skips the baseline pack", () => {
    const res = check(mkdtempSync(join(tmpdir(), "keel-min-")), parseSpec('version: 1\nsafety: { profile: minimal }\n'));
    expect(res.plan.selected.map((p) => p.id)).not.toContain("safety/baseline");
  });
  it("strict profile denies push/publish", () => {
    const dir4 = mkdtempSync(join(tmpdir(), "keel-strict-"));
    try {
      apply(dir4, parseSpec('version: 1\nsafety: { profile: strict }\n'));
      const cfg = JSON.parse(readFileSync(join(dir4, ".devin/config.json"), "utf8"));
      expect(cfg.permissions.deny).toContain("Exec(git push)");
      expect(cfg.permissions.deny).toContain("Exec(pnpm publish)");
      expect(cfg.permissions.ask).not.toContain("Exec(git push)");
    } finally {
      rmSync(dir4, { recursive: true, force: true });
    }
  });
});
