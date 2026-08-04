import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DOCTOR_COMMAND = join(ROOT, "apps/dev/src/commands/red-doctor.ts");

async function readDoctorSkill(): Promise<string> {
  return readFile(join(ROOT, "plugins/dev/skills/engineering/red-doctor/SKILL.md"), "utf8");
}

// The `--fix` Apply table lives in a bundled sibling `APPLY.md`, behind a
// one-line pointer in SKILL.md (issue #1145). Assertions on Apply-row content
// read APPLY.md; assertions on the read-only diagnose pass read SKILL.md.
async function readDoctorApply(): Promise<string> {
  return readFile(join(ROOT, "plugins/dev/skills/engineering/red-doctor/APPLY.md"), "utf8");
}

/**
 * Resolve one import specifier to a repo file, or null when it leaves the
 * source tree (node builtins, published packages, generated assets).
 */
function resolveImport(fromFile: string, specifier: string): string | null {
  const candidate = (path: string): string | null => (existsSync(path) ? path : null);
  if (specifier.startsWith(".")) {
    return candidate(resolve(dirname(fromFile), specifier).replace(/\.js$/, ".ts"));
  }
  for (const [prefix, base] of [
    ["@reddb-io/redskilled/", "apps/redskilled/src"],
    ["@reddb-io/shared/", "packages/shared"],
  ] as const) {
    if (specifier.startsWith(prefix)) {
      return candidate(join(ROOT, base, `${specifier.slice(prefix.length).replace(/\.js$/, "")}.ts`));
    }
  }
  return null;
}

/**
 * Every source file reachable from the doctor command by static import,
 * including the dynamic `import("…")` forms the command uses to defer IO.
 *
 * This is the difference between a check that EXISTS and a check that RUNS: a
 * SKILL.md that names a classifier, plus a unit test that proves the classifier
 * works, still leaves the doctor reporting clean on a dimension it never
 * examines if nothing imports it (#3034).
 */
function reachableFromDoctorCommand(): Set<string> {
  const seen = new Set<string>();
  const stack = [DOCTOR_COMMAND];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const specifiers = [
      ...source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g),
      ...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]!);
    for (const specifier of specifiers) {
      const target = resolveImport(file, specifier);
      if (target) stack.push(target);
    }
  }
  return new Set([...seen].map((file) => relative(ROOT, file)));
}

/** Module paths and bare `*.ts` filenames the SKILL.md names as a check's backing. */
function classifiersNamedBySkill(skill: string): string[] {
  const named = new Set<string>();
  for (const match of skill.matchAll(/apps\/[a-z-]+\/src\/[A-Za-z0-9/_-]+\.ts/g)) {
    named.add(match[0]);
  }
  // A bare filename (`hook-registry.ts`) is a `core/` module by convention.
  for (const match of skill.matchAll(/`([a-z0-9][a-z0-9-]*\.ts)`/g)) {
    named.add(`apps/dev/src/core/${match[1]}`);
  }
  return [...named].sort();
}

describe("doctor classifier reachability", () => {
  it("names at least the classifiers this contract was written for", async () => {
    const named = classifiersNamedBySkill(await readDoctorSkill());

    // Guards the extractor itself: a regex that matched nothing would make the
    // reachability assertion below vacuously green.
    expect(named).toEqual(expect.arrayContaining([
      "apps/dev/src/core/ask-red-router-doctor.ts",
      "apps/dev/src/core/dependency-edge-doctor.ts",
      "apps/dev/src/core/hook-doctor.ts",
      "apps/dev/src/core/hook-registry.ts",
      "apps/dev/src/core/host-binary-doctor.ts",
      "apps/dev/src/core/red-taxonomy-doctor.ts",
      "apps/dev/src/core/runtime-doctor.ts",
      "apps/dev/src/core/unlanded-docs-doctor.ts",
    ]));
  });

  it("reaches every classifier the SKILL.md names from the doctor command", async () => {
    const named = classifiersNamedBySkill(await readDoctorSkill());
    const reachable = reachableFromDoctorCommand();

    expect(named.filter((module) => existsSync(join(ROOT, module)) && !reachable.has(module))).toEqual([]);
  });
});

describe("doctor docs contract", () => {
  it("checks Development-workflow adoption read-only with red-setup as the fix-home", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("AGENTS ≡ CLAUDE Development-workflow parity");
    expect(skill).toContain("`## Development workflow` block");
    expect(skill).toContain("Report `C/A` for presence");
    expect(skill).toContain("out-of-parity block as a finding tagged `→ /red-setup`");
    expect(skill).toContain("do not run `inject-development-workflow`");
    expect(skill).toContain("do not create files");
    expect(skill).toContain("do not edit either agent rules file");
  });

  it("reports the primary-branch guard + config namespacing without mutating config", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Config namespacing + primary-branch guard");
    expect(skill).toContain("read `.red/config.yaml`");
    expect(skill).toContain("canonical key is the namespaced `plugins.dev.lock.primary-branch`");
    expect(skill).toContain("any value other than `true` as \"unset\"");
    expect(skill).toContain("recommend `→ /red-setup`");
    expect(skill).toContain("never write `.red/config.yaml`");
  });

  // #3013: the trigger half (the label) and the safety half (the declaration)
  // are checked as a pair, and the pair is what --fix repairs.
  it("checks the HUMAN-ONLY type label against its hitl_types declaration", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("HUMAN-ONLY type declaration");
    expect(skill).toContain("afk.labels.hitl_types");
    expect(skill).toContain("an unreadable tracker is not a clean repo");
    expect(skill).toContain("never create the label, never write config");

    const apply = await readDoctorApply();
    expect(apply).toContain("HUMAN-ONLY type declaration (check 25)");
    expect(apply).toContain("never duplicate an entry");
    expect(apply).toContain("only it may create a repository's `.red/`");
  });

  it("flags legacy top-level dev-plugin config as a namespacing migration", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Namespacing conformance");
    expect(skill).toContain("dev-plugin settings belong under `plugins.dev.*`");
    expect(skill).toContain("hygiene, not breakage");
    // The `--fix` Apply table has the migration row (now in APPLY.md, #1145).
    const apply = await readDoctorApply();
    expect(apply).toContain("Legacy/top-level dev-plugin config");
  });

  it("audits per-plugin runtime distribution read-only, launcher fetch as the fix-home", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Per-plugin runtime distribution");
    expect(skill).toContain("ADR 0084 control-plane contract");
    // Each named finding class must be documented.
    expect(skill).toContain("runtime-missing");
    expect(skill).toContain("inert-marker");
    expect(skill).toContain("version-drift");
    expect(skill).toContain("cache-corrupt");
    // The former silent-no-op class becomes visible findings.
    expect(skill).toContain("silent-no-op class");
    // A healthy three-plugin setup produces zero findings; disabled is inert.
    expect(skill).toContain("healthy three-plugin setup produces zero findings");
    expect(skill).toContain("inert by design");
    // Drift is suppressed when the latest release can't be resolved.
    expect(skill).toContain("Suppressed when the latest release can't be resolved");
    // Read-only + never touches the network in Pass 1.
    expect(skill).toContain("never touch the network");
    // The pure classifier is named.
    expect(skill).toContain("apps/dev/src/core/runtime-doctor.ts");
    // Fix-home is the launcher fetch, and the --fix re-fetch is gated.
    expect(skill).toContain("`→ launcher fetch`");
    // The gated `--fix` Apply row moved to APPLY.md (#1145).
    const apply = await readDoctorApply();
    expect(apply).toContain("Per-plugin runtime distribution `❌`/`⚠️` (check 13)");
    expect(apply).toContain("confirm each");
  });

  it("audits the host toolchain read-only and documents gated fixes", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Host toolchain");
    expect(skill).toContain("gh >= 2.47.0");
    expect(skill).toContain("asdf");
    expect(skill).toContain("apt");
    expect(skill).toContain("brew");
    expect(skill).toContain("direct binary");
    expect(skill).toContain("TQ_VERSION");
    expect(skill).toContain("Absence or version drift is a red finding");
    expect(skill).toContain("catalog-derived pin, recorded config pin, and observed `tq --version`");
    expect(skill).toContain("toolchain-drift");
    expect(skill).toContain("names all three values");
    expect(skill).toContain("apps/dev/src/core/host-binary-doctor.ts");
    expect(skill).toContain("never run installer scripts during Pass 1");
    expect(skill).toContain("never execute an upgrade or installer during Pass 1");

    const apply = await readDoctorApply();
    expect(apply).toContain("Host toolchain `❌` (check 18)");
    expect(apply).toContain("asdf install github-cli latest && asdf global github-cli latest && asdf reshim github-cli");
    expect(apply).toContain("apt, brew, and direct-binary gh remedies remain printed instructions");
    expect(apply).toContain("install pinned `tq` with the canonical checksum-verified toon installer");
    expect(apply).toContain("confirm each");
  });

  it("validates AFK hook/backpressure commands statically and never executes them", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("AFK hook / backpressure static validation");
    expect(skill).toContain("never execute one");
    expect(skill).toContain("never execute a command");
    // Conservative classification: missing → ❌, unresolvable → ⚠️.
    expect(skill).toContain("non-existent file path");
    expect(skill).toContain("cannot be statically resolved");
    // Unknown hook names are pre-caught read-only.
    expect(skill).toContain("Unknown hook names");
    // --fix cannot auto-fix operator intent — the Apply row (now in APPLY.md,
    // #1145) flags and points at the fix-home.
    const apply = await readDoctorApply();
    expect(apply).toContain("`--fix` cannot auto-fix operator intent");
    expect(skill).toContain("`/red-setup`");
  });

  it("audits native blocked-by vs req:N divergence read-only with triage as the fix-home", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Native blocked-by vs `req:N` divergence audit");
    expect(skill).toContain("ADR 0094 deliberately keeps two dependency surfaces");
    expect(skill).toContain("exclude parent Specs carrying `type:spec`");
    expect(skill).toContain("native blocked-by edge without the matching `req:N` label");
    expect(skill).toContain("`req:N` label without the matching native blocked-by edge");
    expect(skill).toContain("gh issue list --state open --json number,labels");
    expect(skill).toContain("repos/{owner}/{repo}/issues/<ticket-number>/dependencies/blocked_by");
    expect(skill).toContain("nativeBlockedBy: [<blocker-number>, ...]");
    expect(skill).not.toContain("making this audit execute that read directly is a follow-up Ticket");
    expect(skill).toContain("apps/dev/src/core/dependency-edge-doctor.ts");
    expect(skill).toContain("never add/remove labels and never create/delete native edges");
    expect(skill).toContain("native blocked-by vs `req:N` divergence (check 15)");

    const apply = await readDoctorApply();
    expect(apply).toContain("Native blocked-by vs `req:N` divergence (check 15)");
    expect(apply).toContain("do not guess the canonical side");
    expect(apply).toContain("delegate to `/triage`");
  });

  it("audits native sub-issue vs spec:N divergence and fixes with the shared reconciler", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Native sub-issue vs `spec:N` divergence audit");
    expect(skill).toContain("open plus recently-closed Specs carrying `type:spec`");
    expect(skill).toContain("`spec:N` child without the matching native sub-issue edge");
    expect(skill).toContain("native sub-issue child without the matching `spec:N` label");
    expect(skill).toContain("still carries `needs-slicing` once it has at least one `spec:N` child");
    expect(skill).toContain("gh issue list --label type:spec --state all --json number,state,closedAt,labels");
    expect(skill).toContain("gh issue list --label spec:<spec-number> --state all --json number,labels");
    expect(skill).toContain("repos/{owner}/{repo}/issues/<spec-number>/sub_issues");
    expect(skill).toContain("labelChildren: [<ticket-number>, ...]");
    expect(skill).toContain("nativeSubIssues: [<ticket-number>, ...]");
    expect(skill).toContain("apps/dev/src/core/spec-subissue-reconciler.ts");
    expect(skill).toContain("auditSpecSubIssueEdges");
    expect(skill).toContain("executeSpecSubIssueReconcile");
    expect(skill).toContain("never add/remove labels and never create/delete native edges");
    expect(skill).toContain("native sub-issue vs `spec:N` divergence (check 16)");

    const apply = await readDoctorApply();
    expect(apply).toContain("Native sub-issue vs `spec:N` divergence (check 16)");
    expect(apply).toContain("run the shared Spec sub-issue reconciler");
    expect(apply).toContain("attach missing native sub-issue edges");
    expect(apply).toContain("remove stale `needs-slicing`");
    expect(apply).toContain("Do not remove native-only edges or invent missing labels");
  });

  it("audits ask-red router coverage read-only with the maintenance rule as the fix-home", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("ask-red router coverage sync");
    expect(skill).toContain("registered dev skill names from the plugin manifest");
    expect(skill).toContain("registered skill missing from the router");
    expect(skill).toContain("stale router entry");
    expect(skill).toContain("apps/dev/src/core/ask-red-router-doctor.ts");
    expect(skill).toContain("never edit manifests and never rewrite `ask-red`");
    expect(skill).toContain("ask-red router coverage sync (check 17)");

    const apply = await readDoctorApply();
    expect(apply).toContain("ask-red router coverage sync (check 17)");
    expect(apply).toContain("do not patch the router blindly");
    expect(apply).toContain("apply the ask-red maintenance rule");
  });

  it("audits .red lifecycle taxonomy violations read-only with ADR 0098 as the fix-home", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain(".red lifecycle taxonomy");
    expect(skill).toContain("loose file directly under `.red/tmp/`");
    expect(skill).toContain("directory directly under `.red/tmp/` that is not in the lane registry");
    expect(skill).toContain("known durable-state filename still living under `.red/tmp/`");
    expect(skill).toContain("top-level `.red/` directory not documented by ADR 0098");
    expect(skill).toContain("apps/dev/src/core/red-taxonomy-doctor.ts");
    expect(skill).toContain("auditRedTaxonomy");
    expect(skill).toContain("never move, delete, or create files");
    expect(skill).toContain("`.red` lifecycle taxonomy (check 19)");

    const apply = await readDoctorApply();
    expect(apply).toContain("`.red` lifecycle taxonomy (check 19)");
    expect(apply).toContain("do not auto-move content");
    expect(apply).toContain("Delegate to the owning writer");
  });

  it("audits unlanded .red docs with the shared Docs Sweep detector and gated ADR 0092 fix", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Unlanded `.red/` docs");
    expect(skill).toContain("primary checkout but are not landed on `origin/{base}`");
    expect(skill).toContain("apps/dev/src/core/docs-sweep.ts");
    expect(skill).toContain("apps/dev/src/core/unlanded-docs-doctor.ts");
    expect(skill).toContain("never implement a second `.red/` docs comparison");
    expect(skill).toContain("includes untracked files");
    expect(skill).toContain("rendered file list (`state:path`)");
    expect(skill).toContain("`→ ADR 0092 doc-landing lane`");
    expect(skill).toContain("never create a branch, push, open a PR, merge, or mutate the primary checkout");

    const apply = await readDoctorApply();
    expect(apply).toContain("Unlanded `.red/` docs (check 21)");
    expect(apply).toContain("run the ADR 0092 doc-landing lane");
    expect(apply).toContain("Reuse the shared Docs Sweep plan");
    expect(apply).toContain("confirm each");
    expect(apply).toContain("pushes a branch, opens a PR, and merges it");
  });

  it("audits the castle state lane read-only and delegates migration residue fixes", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Castle state lane");
    expect(skill).toContain("`.red/state/castle/`");
    expect(skill).toContain("`history.toonl` and `validation.toonl`");
    expect(skill).toContain("`workers/<id>/state.toon` / `supervisors/<id>/state.toon`");
    expect(skill).toContain("red.castle.state.v1");
    expect(skill).toContain("populated legacy `.red/state/afk/` directory only when a live castle lane also exists");
    expect(skill).toContain("Repos with no castle lane and no legacy AFK lane pass clean");
    expect(skill).toContain("apps/dev/src/core/castle-state-doctor.ts");
    expect(skill).toContain("auditCastleStateLane");
    expect(skill).toContain("never rewrite history, validation, or snapshots");
    expect(skill).toContain("never delete legacy residue");
    expect(skill).toContain("castle state lane findings (check 20)");

    const apply = await readDoctorApply();
    expect(apply).toContain("Castle state lane (check 20)");
    expect(apply).toContain("delegate to the dev durable path migration entrypoint");
    expect(apply).toContain("red-path-migration");
    expect(apply).toContain("Never hand-delete `.red/state/afk/`");
  });

  it("reports executable ticket acceptance-criteria lint read-only with triage as the fix-home", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Executable ticket acceptance-criteria lint");
    expect(skill).toContain("ready-for-agent");
    expect(skill).toContain("machine-checkable acceptance criteria");
    expect(skill).toContain("apps/dev/src/core/executable-acceptance.ts");
    expect(skill).toContain("never edit labels and never post comments");
    expect(skill).toContain("executable ticket acceptance-criteria lint (check 23)");

    const apply = await readDoctorApply();
    expect(apply).toContain("Executable ticket acceptance-criteria lint (check 23)");
    expect(apply).toContain("delegate to `/triage`");
  });

  it("reports execution daemon provisioning read-only, with red-setup as the fix-home", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Execution daemon provisioning");
    for (const check of ["`home`", "`daemon-entry`", "`reach`", "`supervisor-unit`"]) {
      expect(skill).toContain(check);
    }
    expect(skill).toContain("~/.red/redskilled/");
    expect(skill).toContain("apps/redskilled/src/provision.ts");
    expect(skill).toContain("auditRedskilledProvisioning");
    // The optional unit is reported, never flagged.
    expect(skill).toContain("The optional unit is reported and never flagged");
    // Read-only means it neither starts the daemon nor creates the home.
    expect(skill).toContain("never spawn the daemon");
    expect(skill).toContain("never create the home");
    expect(skill).toContain("execution daemon provisioning (check 24)");
    expect(skill).toContain("redskilled provision");
  });

  // #3059: the source a marketplace was registered from is what decides whether
  // `marketplace update` can ever advance the machine.
  it("audits the marketplace registration source read-only with a gated repoint", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Marketplace registration source");
    expect(skill).toContain("re-reads **whatever source the marketplace was registered from**");
    expect(skill).toContain("frozen-directory-source");
    expect(skill).toContain("source-unknown");
    expect(skill).toContain("an uninstalled host registered nothing, so it can freeze nothing");
    expect(skill).toContain("apps/dev/src/core/marketplace-source-doctor.ts");
    expect(skill).toContain("auditMarketplaceSources");
    expect(skill).toContain("never add, remove, or update a registration");
    expect(skill).toContain("Directory-sourced `red-skills` marketplace (check 26)");

    const apply = await readDoctorApply();
    expect(apply).toContain("Marketplace registration source (check 26)");
    expect(apply).toContain("plugin marketplace add reddb-io/red-skills");
    expect(apply).toContain("Never repoint a `source-unknown` finding");
    expect(apply).toContain("confirm each");
  });

  // #3062: MCP servers register at plugin load, so a mid-session install writes
  // the declaration and starts nothing. The doctor must say so, in the cure's
  // own words, instead of leaving the operator to re-derive it forensically.
  it("flags declared-but-unloaded MCP servers with the reload cure and an honest seam", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Declared-but-unloaded MCP servers");
    expect(skill).toContain("registers MCP servers **at plugin load**");
    expect(skill).toContain("declared-unloaded");
    expect(skill).toContain("partially-loaded");
    expect(skill).toContain("session-unobserved");
    // The cure, verbatim.
    expect(skill).toContain("restart the session, or run `/reload-plugins`");
    // The seam is stated, not implied.
    expect(skill).toContain("The seam, stated honestly");
    expect(skill).toContain("--session-mcp");
    expect(skill).toContain("Omitting the flag is never read as a clean session");
    expect(skill).toContain("apps/dev/src/core/mcp-load-doctor.ts");
    expect(skill).toContain("auditMcpLoad");
    expect(skill).toContain("never restart a host, never reload plugins");
    expect(skill).toContain("declared-but-unloaded MCP servers (check 27)");
    expect(skill).toContain("`→ host session reload`");

    const apply = await readDoctorApply();
    expect(apply).toContain("Declared-but-unloaded MCP servers (check 27)");
    expect(apply).toContain("would kill its own caller");
    expect(apply).toContain("only the load is missing");
  });

  it("documents the operational probe families, fix authority, and fleet boot refusal", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Operational probe families");
    for (const probe of [
      "git.remote.https-forbidden",
      "afk.queue-visibility",
      "afk.focal-branch-resolution",
      "afk.base-freshness",
      "afk.fleet-truth",
      "afk.claim-hygiene",
      "afk.label-body-coherence",
      "config.coherence",
    ]) {
      expect(skill).toContain(probe);
    }
    expect(skill).toContain("what it checks");
    expect(skill).toContain("evidence it shows");
    expect(skill).toContain("read-only by default");
    expect(skill).toContain("destructive fixes are individually gated under `--fix`");
    expect(skill).toContain("Fleet boot refusal");
    expect(skill).toContain("boot auto-applies the guarded reconciliation");
    expect(skill).toContain("superseded local-to-origin SHA pairs");
    expect(skill).toContain("refuses to spawn workers");
    expect(skill).toContain("BootHaltError(\"operational-probe\")");
  });
});
