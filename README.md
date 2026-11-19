# keel

[![ci](https://github.com/AlbertPa00/keel/actions/workflows/ci.yml/badge.svg)](https://github.com/AlbertPa00/keel/actions/workflows/ci.yml)
[![keel-verify](https://github.com/AlbertPa00/keel/actions/workflows/keel-verify.yml/badge.svg)](https://github.com/AlbertPa00/keel/actions/workflows/keel-verify.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

**Deterministic constraint compiler for coding agents** — Devin CLI, Claude Code, Cursor, Windsurf, GitHub Copilot, and Codex.

`keel` compiles a single human-reviewed `harness.yaml` into **mechanical guardrails first, minimal prose last**: polyglot import-boundary gates, regex check packs with error/warn severity, safe permission baselines, lifecycle hooks, scoped rules, SHA-256-pinned skills, a drift-checked `keel.lock.json`, and a CI-ready verify gate.

No LLM inside the compiler. Same spec + catalog version = byte-identical output.

---

## Why `keel` Exists

1. **Generated `AGENTS.md` prose hurts more than it helps.** Empirical benchmarks ([Evaluating AGENTS.md](https://arxiv.org/abs/2602.11988)) show verbose, auto-generated context files fail to raise task success while inflating token cost by >20%. Only concise, non-standard invariants earn their keep.
2. **Wild skill retrieval hits a ceiling.** [SkillsBench](https://www.skillsbench.ai/) shows a small curated set of skills helps, while uncurated retrieval and self-generated skills regress toward baseline and introduce paradigm conflicts.
3. **Prose is advisory; hooks, permissions, and boundary checks are law.** `keel` labels every constraint honestly on the **enforcement ladder**:
   - `enforced` — mechanically blocked by permissions, lifecycle hooks, or import-boundary checks.
   - `checked` — verified by `.keel/verify.mjs` before an agent turn can finish.
   - `advised` — Markdown instruction or skill guidance only.

---

## Architecture

```text
  harness.yaml  +  Workspace Fingerprint  +  ~/.config/devin/taste.json
         │                   │                           │
         └───────────────────┴─────────────┬─────────────┘
                                           ▼
                         ┌─────────────────────────────────┐
                         │  Faceted Resolver (5 Slots)     │
                         │  stack · architecture · style   │
                         │  safety · workflow              │
                         │  + version & paradigm pruning   │
                         └─────────────────┬───────────────┘
                                           ▼
     ┌──────────────────┬──────────────────┼──────────────────┬─────────────────┐
     ▼                  ▼                  ▼                  ▼                 ▼
 AGENTS.md      .devin/ .claude/    .cursor/ .windsurf/   .keel/          keel.lock.json
 (managed block, .codex/ .github/    rules/   rules/     harness.json     (SHA-256 hashes
  <1k tok cap)   config + hooks     copilot   (scoped)   verify.mjs        + inverse-merge
                 rules + skills     instructions         check-*.mjs       undo journal)
                                                         hooks/*.mjs
```

### Packages

| Package | Role |
| :--- | :--- |
| `@keel/core` | Zod spec & pack schemas, read-only polyglot fingerprinter, 27 seed packs across 5 slots, faceted resolver, deterministic emitters (`AGENTS.md` + six agent targets + `.keel/` gates), lockfile, `plan` / `apply` / `check` / `outdated` / `remove`. |
| `keel` (`packages/cli`) | Zero-bloat CLI wrapping `@keel/core` — also ships as a single-file `dist/keel.mjs` esbuild bundle. |
| `keel-mcp` (`packages/mcp`) | Thin stdio MCP server exposing 11 tools so an agent can interview you, draft `harness.yaml`, preview plans, apply, and audit drift. |

---

## Install (from source)

`keel` is not published to npm yet — build it from this checkout:

```bash
git clone https://github.com/AlbertPa00/keel.git && cd keel
pnpm install && pnpm -r build
```

Then put `keel` on PATH (any of these work):

```bash
# Option A — global symlink
cd packages/cli && pnpm link --global        # then: keel <cmd>

# Option B — the single-file bundle (self-contained, pack catalog beside it)
node /path/to/keel/packages/cli/dist/keel.mjs <cmd>

# Option C — workspace build
node /path/to/keel/packages/cli/dist/index.js <cmd>
```

## Using `keel` on a repository

```bash
cd /path/to/repo

keel fingerprint                # 1. read-only repo detection (never runs project code)
keel init --discover            # 2. draft harness.yaml — auto-synthesizes layers +
                                #    ratchet exceptions from the real import graph
keel plan                       # 3. dry-run: selected packs, coverage, tokens, file ops
keel apply                      # 4. write the harness + keel.lock.json
keel check                      # 5. CI: exit 1 on any drift or un-applied spec change
keel outdated                   #    which selected packs changed since last apply
keel remove                     # 6. uninstall — restores your files byte-identically
```

Other commands: `keel search <query> [--slot s]`, `keel packs [list|show <id>]`, `keel doctor` (environment + harness health), `keel taste [--set k=v]` (cross-project defaults in `~/.config/devin/taste.json` — used at `init`/`draft` only), and the brownfield pair:

```bash
keel graph                      # print the real cross-directory import graph (polyglot, monorepo-aware)
keel ratchet                    # record today's boundary violations as file-level architecture.exceptions
```

`ratchet` is the honest way to adopt `keel` on code with existing violations: declare the *target* architecture in `layers`, then quarantine each violating **file** as an exception — new violations still fail, old ones shrink as you fix them, and stale exceptions fail the gate once the debt is gone (`init --discover` does this whole dance for you). Re-run `keel ratchet` after refactors to tighten the list.

Flags: `[dir]` positional or `--dir <path>` selects the target repo (default `.`); `--spec <path>` overrides the spec location; `init --force` overwrites an existing `harness.yaml`; `init --discover` synthesizes `architecture.layers` from the import graph; `--json` on `plan`/`search` emits machine-readable output.

### What `apply` changes in your agent sessions

- **Devin CLI** reads `.devin/config.json` permissions (allow/ask/deny), `hooks.v1.json` (Stop + PostCompaction + turn-tracking), `.devin/rules/*.md` (glob-scoped), and `.devin/skills/`.
- **Claude Code** reads `.claude/settings.json` permissions + hooks, `.claude/rules/*.md` (same scoped rules as Devin), and `.claude/skills/`.
- **Cursor** reads `.cursor/rules/keel-*.mdc` (frontmatter `alwaysApply`/`globs`/`description` mapped from pack triggers).
- **Windsurf** reads `.windsurf/rules/keel-*.md` (same trigger vocabulary).
- **GitHub Copilot** reads the `.github/copilot-instructions.md` managed block + `.github/instructions/keel-*.instructions.md` (`applyTo` globs).
- **Codex** reads `AGENTS.md` natively — no extra files, and `plan` says so honestly.
- **All** read the `AGENTS.md` managed block (≤ `budget.always_on_tokens`).
- `node .keel/verify.mjs` is the single gate the Stop hook runs: boundary check → pack checks → style gate → your `autonomy.verify` command. The Stop hook is **mutation-aware**: `UserPromptSubmit`/`PostToolUse` markers mean it only runs the gate on turns that actually changed files — read-only Q&A turns skip it instantly.

### What to commit

Commit **all of it**: `harness.yaml`, `keel.lock.json`, `AGENTS.md`, `.devin/`, `.claude/`, `.keel/`. The generated `.mjs` scripts are plain auditable files — committing them means agents get the guardrails even where `keel` isn't installed, and `keel check` in CI proves nothing drifted.

### Day-2 workflow

Edit `harness.yaml` → `keel plan` (review the diff + coverage) → `keel apply` → commit. `keel check` fails until you apply — hand-editing generated files also fails it.

---

## Example `harness.yaml`

```yaml
version: 1
targets: [devin, claude]

project:
  name: billing-service
  intent: hexagonal Node API with strict functional core and OWASP boundary validation

stack:
  language: typescript
  package_manager: pnpm
  frameworks: [express, prisma, vitest, zod]

architecture:
  style: hexagonal
  layers:
    - name: domain
      paths: ["src/domain/**"]
      may_import: []
    - name: application
      paths: ["src/application/**"]
      may_import: [domain]
    - name: adapters
      paths: ["src/adapters/**"]
      may_import: [domain, application]
  exceptions:                       # brownfield ratchet — shrink-only, per file
    - file: src/application/legacy.ts
      allow: [adapters]

style:
  paradigm: fp
  max_function_lines: 25
  max_nesting: 2
  comments: minimal
  principles: [solid, tdd]

safety:
  profile: strict

autonomy:
  mode: autonomous-verified
  verify: pnpm typecheck && pnpm lint && pnpm test
  stop_hook: true
  post_compaction: true

budget:
  always_on_tokens: 800
  max_skills: 5
```

### `harness.yaml` field reference

| Field | Values / default | Effect |
| :--- | :--- | :--- |
| `targets` | `devin`, `claude`, `cursor`, `windsurf`, `copilot`, `codex` (default `[devin]`) | Which tool configs to emit. `AGENTS.md` is always emitted. |
| `project.intent` | free text | Faceted resolver signal only — never copied into output. |
| `stack.language` · `package_manager` | `typescript` · `pnpm` | Resolver key + `Exec(<pm> add)` ask-permission. |
| `stack.frameworks` | `[react, prisma, …]` | Matches `pack.stack_keys`; merged with detected frameworks. |
| `architecture.style` | `layered`, `hexagonal`, `atomic-design`, … | Auto-includes the matching pack. |
| `architecture.layers[]` | `name`, `paths[]`, `may_import[]` | Emits `.keel/check-boundaries.mjs` — the only `enforced` architecture gate. |
| `architecture.exceptions[]` | `file`, `allow[]` | Per-file ratchet for known-debt imports; only those files may cross those layers. Manage with `keel ratchet`. |
| `style.paradigm` | `fp` · `oop` · `hybrid` | Prunes conflicting-paradigm packs. |
| `style.max_function_lines` · `max_nesting` | `0` = off | Emits `.keel/check-style.mjs` into the verify gate. |
| `style.comments` | `minimal` · `jsdoc-public` · `normal` | Always-on comment policy line (`normal` emits none). |
| `style.principles` | `[solid, tdd, …]` | Matches `pack.principle_keys`. |
| `safety.profile` | `minimal` · `standard` · `strict` | `minimal` skips the baseline pack (unless explicitly included); `strict` denies push/publish outright. |
| `safety.extra_allow` / `extra_ask` / `extra_deny` | `Exec(...)`, `Write(...)`, `Read(...)`, `Fetch(...)` | Merged into both adapters' permission sets (deny wins). |
| `autonomy.mode` | `guided` · `autonomous-verified` · `strict-gated` | `guided` skips Stop hook + verified-completion; `strict-gated` asks on all unlisted Exec. |
| `autonomy.verify` | shell command | The one command `verify` runs (fallback: detected `verify`/`typecheck`/`lint`/`test` scripts). |
| `autonomy.stop_hook` · `post_compaction` | `true` | Emit `.keel/hooks/` entries into `.devin/hooks.v1.json` + `.claude/settings.json` (Stop only — no PostCompact event on Claude). |
| `budget.always_on_tokens` | `1000` | Hard cap on the `AGENTS.md` managed block — plan errors when exceeded. |
| `budget.max_skills` | `5` | Hard cap on installed skills. |
| `packs.include` / `packs.exclude` | pack ids | Force-include (bypasses scoring) / hard-exclude. |
| `packs.dirs` | `[.keel/packs, org/catalog, …]` | Layered catalogs merged over the bundled one — later roots override by id; perfect for org/team packs. |
| `autonomy.ci` | `github` | Emits `.github/workflows/keel-verify.yml` (drift check + verify gate on every PR). |

### Seed pack catalog (27)

| Pack | Slot | Enforcement | What it adds |
| :--- | :--- | :--- | :--- |
| `architecture/layered` · `hexagonal` · `atomic-design` | architecture | **enforced**¹ | Boundary rules + skill + violation fixtures |
| `safety/baseline` | safety | **enforced** | Deny secrets/lockfiles/sudo/destructive ops; ask installs+pushes |
| `safety/api-owasp` | safety | **checked** | no-eval, no-unsafe-raw-sql, no-hardcoded-secret |
| `workflow/verified-completion` | workflow | **enforced** | Stop-hook verify gate discipline |
| `workflow/tdd` | workflow | advised | Red-green-refactor skill |
| `style/fp-strict` · `oop-strict` | style | advised | Paradigm style rules (mutually exclusive) |
| `stack/typescript-strict` · `vitest` · `jest` · `node-api` · `prisma` · `drizzle` · `react-composition` · `next` · `vue` · `svelte` · `trpc` · `zod` · `playwright` · `tailwind`² | stack | **checked**² | Scoped rules + skills + `emits.checks` gates for the matched stack |
| `stack/python-strict` · `fastapi` · `go-idiomatic` · `rust-idiomatic` | stack | **checked** | Same machinery for Python/Go/Rust repos |

¹ Architecture packs are `enforced` only when `architecture.layers` is declared — the plan downgrades the claim to `advised` with a warning otherwise (enforcement honesty).
² `stack/tailwind` is `advised` (no mechanical check yet); all others ship `emits.checks` that run in the verify gate.

Every `checked` pack ships `fixtures/violating-*` + `compliant` test files, and each check supports `severity: error | warn` — warns report findings without failing the gate. Checks honor `// keel-ignore <pack>/<check>: <reason>` (reason mandatory) and `// keel-ignore-file` for accountable suppression.

---

### Devin CLI (`.devin/mcp_config.json` or `~/.config/devin/mcp_config.json`)

```json
{
  "mcpServers": {
    "keel": {
      "command": "node",
      "args": ["/absolute/path/to/keel/packages/mcp/dist/index.js"]
    }
  }
}
```

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "keel": {
      "command": "node",
      "args": ["/absolute/path/to/keel/packages/mcp/dist/index.js"]
    }
  }
}
```

### Exposed MCP Tools

| Tool | Writes Disk? | Purpose |
| :--- | :---: | :--- |
| `keel_fingerprint` | No | Deterministically detect stack, package manager, frameworks, test runner, linter, and agent dirs. |
| `keel_draft_spec` | No | Build a draft `harness.yaml` marking `detected` / `stated` fields, surfacing repo conflicts and open questions. |
| `keel_search` | No | Query the curated pack catalog by slot (`stack`, `architecture`, `style`, `safety`, `workflow`). |
| `keel_plan` | No | Dry-run compilation: selected/rejected packs, enforcement coverage, token cost, and planned file ops. |
| `keel_apply` | `dry_run=false` | Apply the compiled harness and write `keel.lock.json` (`dry_run` defaults to `true`). |
| `keel_check` | No | Offline drift check comparing desired compiled state against disk and `keel.lock.json`. |
| `keel_graph` | No | Report the repo's real module-level import graph — use before declaring `architecture.layers`. |
| `keel_ratchet` | `dry_run=false` | Write current boundary violations into `harness.yaml` as `architecture.exceptions` (then `keel_apply`). |
| `keel_remove` | Yes | Inverse-merge uninstall that strips only `keel`-managed blocks/entries and deletes created files. |
| `keel_doctor` | No | Environment + harness health check (Node version, lockfile freshness, emitted-file integrity). |
| `keel_taste` | Optional | Read or update your cross-project personal taste profile (`~/.config/devin/taste.json`). |

---

## Safety & Non-Destructive Guarantees

- **Managed Markdown blocks:** `AGENTS.md`/`CLAUDE.md` are updated strictly between `<!-- keel:begin -->` and `<!-- keel:end -->`; user-authored documentation outside those markers is untouched.
- **Additive JSON merging with undo journal:** `.devin/config.json`, `.devin/hooks.v1.json`, and `.claude/settings.json` preserve existing user permissions and hooks; `deny` rules always win and never weaken existing user denies. User entries displaced by a `keel` deny are recorded in the lockfile and restored on `remove`.
- **Inverse-merge on scope reduction:** Removing a target or pack strips only `keel`-managed content from pre-existing files — files you owned before `keel` are never deleted, only restored.
- **Cross-tool duplicate-ingestion guard:** When both targets are emitted, `.devin/config.json` sets `read_config_from.claude: false` so generated rules/skills are never double-loaded into Devin sessions; the flag is removed again on `remove` or when the Claude target is dropped.
- **Style gate:** `style.max_function_lines` / `style.max_nesting` emit `.keel/check-style.mjs`, which `verify` runs before the project's own commands (heuristic, comment-aware; `0` disables).
- **Lockfile-verified drift checks:** `keel check` fails on modified/missing/stale files *and* on spec or catalog hash drift — a spec edit without `keel apply` is always reported. `.keel/check-drift.mjs` verifies the same invariant in CI with zero dependencies.
- **Per-pack upgrade visibility:** `keel outdated` reports which selected packs changed content or version since the last `apply`, and which were added or removed.
- **Polyglot boundary enforcement:** `check-boundaries.mjs` parses TypeScript/JavaScript, Python (`import` / `from`, relative dots, src-layout), Go (single + block imports, `go.mod` prefixes), and Rust (`use`, `crate::`/`self::`/`super::`, Cargo workspace aliases) with identical semantics to the TypeScript engine.
- **Mechanical pack checks with honest severity:** `emits.checks` rules (`forbid_regex`/`require_regex`, comment/string-aware masking, `error`/`warn` severity) run in `.keel/check-packs.mjs` — warnings inform, errors fail.
- **Shrink-only ratchets:** exceptions that no longer quarantine a real violation fail the boundary gate — fixing legacy code permanently locks in the improvement.
- **Loop-guarded `Stop` verification:** `.keel/hooks/stop-verify.mjs` honors `stop_hook_active` so failed verification prompts self-healing once without trapping the session in an infinite loop — and it only runs on turns that actually mutated files (`UserPromptSubmit`/`PostToolUse` turn markers in `.keel/state/`, which you should gitignore).
- **Deterministic for teams:** `harness.yaml` is the sole source of truth at `plan`/`apply`/`check` — your `taste.json` only seeds `init`/`draft`. Personal day-2 overrides live in a gitignored `harness.local.yaml`, deep-merged per-section so two developers can share a spec but keep their own `stop_hook`, token budget, or verify command.

---

## Development

```bash
pnpm -r build          # strict tsc emit + typecheck across all packages (same as `pnpm typecheck`)
pnpm lint              # ESLint (0 warnings)
pnpm test              # Vitest unit + end-to-end suite
node .keel/verify.mjs  # dogfooded boundary + typecheck + lint + test gate
```
