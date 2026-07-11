import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readDoctorSkill(): Promise<string> {
  return readFile(join(ROOT, "plugins/dev/skills/engineering/red-doctor/SKILL.md"), "utf8");
}

// The `--fix` Apply table lives in a bundled sibling `APPLY.md`, behind a
// one-line pointer in SKILL.md (issue #1145). Assertions on Apply-row content
// read APPLY.md; assertions on the read-only diagnose pass read SKILL.md.
async function readDoctorApply(): Promise<string> {
  return readFile(join(ROOT, "plugins/dev/skills/engineering/red-doctor/APPLY.md"), "utf8");
}

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
    expect(skill).toContain("apps/dev/src/core/dependency-edge-doctor.ts");
    expect(skill).toContain("never add/remove labels and never create/delete native edges");
    expect(skill).toContain("native blocked-by vs `req:N` divergence (check 15)");

    const apply = await readDoctorApply();
    expect(apply).toContain("Native blocked-by vs `req:N` divergence (check 15)");
    expect(apply).toContain("do not guess the canonical side");
    expect(apply).toContain("delegate to `/triage`");
  });

  it("audits ask-red router coverage read-only with the maintenance rule as the fix-home", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("ask-red router coverage sync");
    expect(skill).toContain("registered dev skill names from the plugin manifest");
    expect(skill).toContain("registered skill missing from the router");
    expect(skill).toContain("stale router entry");
    expect(skill).toContain("apps/dev/src/core/ask-red-router-doctor.ts");
    expect(skill).toContain("never edit manifests and never rewrite `ask-red`");
    expect(skill).toContain("ask-red router coverage sync (check 16)");

    const apply = await readDoctorApply();
    expect(apply).toContain("ask-red router coverage sync (check 16)");
    expect(apply).toContain("do not patch the router blindly");
    expect(apply).toContain("apply the ask-red maintenance rule");
  });
});
