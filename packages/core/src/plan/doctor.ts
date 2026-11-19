import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readJson } from "../util/fs.js";
import { fingerprint } from "../fingerprint.js";
import { check } from "./ops.js";
import { loadSpec } from "../spec/load.js";

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

const semverMajor = (v: string): number | null => {
  const m = /(\d+)/.exec(v);
  return m ? Number(m[0]) : null;
};

const rangeMajor = (range: string): number | null => {
  const m = /(\d+)/.exec(range);
  return m ? Number(m[0]) : null;
};

/**
 * Environment + harness health check — the failures an agent hits before the
 * verify gate can even run (missing pm, uninstalled deps, drift). Read-only.
 */
export function doctor(dir: string): DoctorReport {
  const checks: DoctorCheck[] = [];
  const fp = fingerprint(dir);
  const pkg = readJson<{ engines?: { node?: string }; packageManager?: string }>(join(dir, "package.json"));

  const required = rangeMajor(pkg?.engines?.node ?? "");
  const current = semverMajor(process.versions.node);
  if (required !== null && current !== null) {
    checks.push(
      current >= required
        ? { name: "node", status: "pass", detail: `node ${process.versions.node} satisfies engines ${pkg?.engines?.node}` }
        : {
            name: "node",
            status: "fail",
            detail: `node ${process.versions.node} < engines ${pkg?.engines?.node}`,
            fix: `upgrade Node to >=${required}`,
          },
    );
  }

  const pm = pkg?.packageManager?.split("@")[0] ?? fp.package_manager;
  if (pm) {
    const probe = spawnSync(pm, ["--version"], { encoding: "utf8", shell: true });
    checks.push(
      probe.status === 0
        ? { name: "package-manager", status: "pass", detail: `${pm} ${String(probe.stdout).trim()} on PATH` }
        : {
            name: "package-manager",
            status: "fail",
            detail: `${pm} not found on PATH`,
            fix: pm === "pnpm" ? "corepack pnpm --version || npm i -g pnpm" : `install ${pm}`,
          },
    );
  }

  if (existsSync(join(dir, "package.json"))) {
    checks.push(
      existsSync(join(dir, "node_modules"))
        ? { name: "deps", status: "pass", detail: "node_modules present" }
        : { name: "deps", status: "warn", detail: "node_modules missing", fix: `${pm ?? "npm"} install` },
    );
  }

  let spec = null;
  try {
    spec = loadSpec(dir).spec;
    checks.push({ name: "spec", status: "pass", detail: "harness.yaml loaded" });
  } catch (e) {
    checks.push({
      name: "spec",
      status: "warn",
      detail: (e as Error).message.split("\n")[0] ?? "no harness.yaml",
      fix: "keel init",
    });
  }

  if (spec) {
    const res = check(dir, spec);
    if (res.ok) checks.push({ name: "drift", status: "pass", detail: "harness in sync (keel check green)" });
    else {
      const parts = [
        res.modified.length ? `${res.modified.length} modified` : "",
        res.missing.length ? `${res.missing.length} missing` : "",
        res.stale.length ? `${res.stale.length} stale` : "",
        res.spec_stale ? "spec drifted" : "",
      ].filter(Boolean);
      checks.push({
        name: "drift",
        status: "fail",
        detail: parts.join(", ") || "drift",
        fix: "keel apply",
      });
    }
    if (existsSync(join(dir, ".keel", "verify.mjs"))) {
      checks.push({ name: "verify-gate", status: "pass", detail: ".keel/verify.mjs present" });
    } else {
      checks.push({ name: "verify-gate", status: "warn", detail: ".keel/verify.mjs missing", fix: "keel apply" });
    }
  }

  const ok = checks.every((c) => c.status !== "fail");
  return { ok, checks };
}
