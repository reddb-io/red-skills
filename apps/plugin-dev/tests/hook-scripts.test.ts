import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execTool } from "../src/runtime/exec.js";

/**
 * Parity tests for the `red-*` library hook scripts. Each test runs the actual
 * script against a controlled env/stdin and asserts it reproduces the old
 * default's behavior. Scripts live at
 * `<repo>/plugins/dev/skills/engineering/afk/hooks/`.
 *
 * Requires bash + jq (same runtime as production). Tests that can't locate the
 * scripts (bundled install without the surrounding tree) skip gracefully.
 */

const here = new URL(import.meta.url).pathname; // .../apps/plugin-dev/tests/hook-scripts.test.ts
const repoRoot = here.slice(0, here.indexOf("/apps/plugin-dev/"));
const hooksDir = join(
  repoRoot,
  "plugins",
  "dev",
  "skills",
  "engineering",
  "afk",
  "hooks",
);
const afkSkillDir = join(
  repoRoot,
  "plugins",
  "dev",
  "skills",
  "engineering",
  "afk",
);

function scriptPath(name: string): string {
  return join(hooksDir, name);
}

function skipIfMissing(name: string): boolean {
  return !existsSync(scriptPath(name));
}

async function runScript(
  name: string,
  env: Record<string, string>,
  stdin: string,
): Promise<{ code: number; stdout: string }> {
  const path = scriptPath(name);
  // Scripts use bash-specific features (set -uo pipefail, shopt). Run with
  // bash explicitly rather than sh so the shebang-declared interpreter is
  // honoured regardless of /bin/sh pointing to dash/busybox.
  const r = await execTool("bash", [path], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    input: stdin,
  });
  return { code: r.code, stdout: r.stdout };
}

describe("Gradle shell portability", () => {
  it("keeps the cheap Gradle leaf and legacy applicability surfaces POSIX-parseable", async () => {
    for (const relative of [
      "hooks/red-gradle",
      "detectors/gradle.sh",
      "defaults/gradle-pre-worktree.sh",
    ]) {
      const result = await execTool("sh", ["-n", join(afkSkillDir, relative)]);
      expect(result.code, relative).toBe(0);
    }
  });
});

describe("red-cargo parity", () => {
  it("acts as a leaf without repeating Cargo.toml detection", async () => {
    if (skipIfMissing("red-cargo")) return;
    const tmp = mkdtempSync(join(tmpdir(), "red-cargo-"));
    const base = join(tmp, "cargo-target");
    const r = await runScript(
      "red-cargo",
      { PROJECT_ROOT: tmp, RED_AFK_SLOT: "2", RED_AFK_CARGO_TARGET_BASE: base },
      "{}",
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim()).env.CARGO_TARGET_DIR).toBe(
      `${base}/slot-2`,
    );
  });

  it("injects CARGO_TARGET_DIR into env when Cargo.toml present", async () => {
    if (skipIfMissing("red-cargo")) return;
    const tmp = mkdtempSync(join(tmpdir(), "red-cargo-"));
    writeFileSync(join(tmp, "Cargo.toml"), '[package]\nname = "test"\n');
    const base = join(tmp, "cargo-target");
    const r = await runScript(
      "red-cargo",
      { PROJECT_ROOT: tmp, RED_AFK_SLOT: "3", RED_AFK_CARGO_TARGET_BASE: base },
      "{}",
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.env.CARGO_TARGET_DIR).toBe(`${base}/slot-3`);
  });

  it("merges with existing env object in context", async () => {
    if (skipIfMissing("red-cargo")) return;
    const tmp = mkdtempSync(join(tmpdir(), "red-cargo-"));
    writeFileSync(join(tmp, "Cargo.toml"), '[package]\nname = "test"\n');
    const base = join(tmp, "cargo-target");
    const ctx = JSON.stringify({ env: { EXISTING_VAR: "kept" } });
    const r = await runScript(
      "red-cargo",
      { PROJECT_ROOT: tmp, RED_AFK_SLOT: "0", RED_AFK_CARGO_TARGET_BASE: base },
      ctx,
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.env.EXISTING_VAR).toBe("kept");
    expect(out.env.CARGO_TARGET_DIR).toBe(`${base}/slot-0`);
  });
});

describe("red-gradle parity", () => {
  it("acts as a leaf without repeating build.gradle detection", async () => {
    if (skipIfMissing("red-gradle")) return;
    const tmp = mkdtempSync(join(tmpdir(), "red-gradle-"));
    const base = join(tmp, "gradle-home");
    const r = await runScript(
      "red-gradle",
      {
        PROJECT_ROOT: tmp,
        RED_AFK_SLOT: "1",
        RED_AFK_GRADLE_USER_HOME_BASE: base,
      },
      "{}",
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim()).env.GRADLE_USER_HOME).toBe(
      `${base}/slot-1`,
    );
  });

  it("pass-through when RED_AFK_GRADLE_USER_HOME_BASE is unset (opt-in)", async () => {
    if (skipIfMissing("red-gradle")) return;
    const tmp = mkdtempSync(join(tmpdir(), "red-gradle-"));
    writeFileSync(join(tmp, "build.gradle"), "// gradle");
    const r = await runScript(
      "red-gradle",
      { PROJECT_ROOT: tmp, RED_AFK_SLOT: "0" },
      "{}",
    );
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("injects GRADLE_USER_HOME when build.gradle present and base is set", async () => {
    if (skipIfMissing("red-gradle")) return;
    const tmp = mkdtempSync(join(tmpdir(), "red-gradle-"));
    writeFileSync(join(tmp, "build.gradle"), "// gradle");
    const base = join(tmp, "gradle-home");
    const r = await runScript(
      "red-gradle",
      {
        PROJECT_ROOT: tmp,
        RED_AFK_SLOT: "2",
        RED_AFK_GRADLE_USER_HOME_BASE: base,
      },
      "{}",
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.env.GRADLE_USER_HOME).toBe(`${base}/slot-2`);
  });
});

describe("red-heartbeat parity", () => {
  it("exits 0 and emits no stdout regardless of env", async () => {
    if (skipIfMissing("red-heartbeat")) return;
    const r = await runScript("red-heartbeat", {}, "{}");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("appends iteration-stopped boundary marker to RED_AFK_ITER_LOG when file exists", async () => {
    if (skipIfMissing("red-heartbeat")) return;
    const tmp = mkdtempSync(join(tmpdir(), "red-heartbeat-"));
    const logPath = join(tmp, "afk.log");
    writeFileSync(
      logPath,
      "[heartbeat] iteration started for #1 at 2026-01-01T00:00:00Z\n",
    );
    const r = await runScript(
      "red-heartbeat",
      { RED_AFK_ITER_LOG: logPath },
      "{}",
    );
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
    const content = readFileSync(logPath, "utf8");
    expect(content).toMatch(/\[heartbeat\] iteration stopped at /);
  });

  it("skips boundary marker write when RED_AFK_ITER_LOG file does not exist", async () => {
    if (skipIfMissing("red-heartbeat")) return;
    const r = await runScript(
      "red-heartbeat",
      { RED_AFK_ITER_LOG: "/tmp/no-such-file-xyz.log" },
      "{}",
    );
    expect(r.code).toBe(0);
  });

  it("gracefully handles missing RED_AFK_HEARTBEAT_PID (no external heartbeat)", async () => {
    if (skipIfMissing("red-heartbeat")) return;
    // No PID set — must not crash.
    const r = await runScript("red-heartbeat", {}, "");
    expect(r.code).toBe(0);
  });
});

describe("red-envelope parity", () => {
  it("no-ops when RED_AFK_STATE_FILE is unset", async () => {
    if (skipIfMissing("red-envelope")) return;
    const ctx = JSON.stringify({
      result: { status: "success", outcome: "done" },
    });
    const r = await runScript("red-envelope", {}, ctx);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("no-ops when state file does not exist", async () => {
    if (skipIfMissing("red-envelope")) return;
    const ctx = JSON.stringify({
      result: { status: "fail", outcome: "no-sentinel" },
    });
    const r = await runScript(
      "red-envelope",
      { RED_AFK_STATE_FILE: "/tmp/no-such-state.json" },
      ctx,
    );
    expect(r.code).toBe(0);
  });

  it("writes result_status from context into state file", async () => {
    if (skipIfMissing("red-envelope")) return;
    const tmp = mkdtempSync(join(tmpdir(), "red-envelope-"));
    const stateFile = join(tmp, "afk.state.toon");
    writeFileSync(
      stateFile,
      JSON.stringify({ current: { activity: "running" } }),
    );
    const ctx = JSON.stringify({
      result: { status: "success", outcome: "done" },
    });
    const r = await runScript(
      "red-envelope",
      { RED_AFK_STATE_FILE: stateFile },
      ctx,
    );
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.current.result_status).toBe("success");
    expect(state.current.activity).toBe("running");
  });

  it("falls back to RED_AFK_RESULT_STATUS env when ctx.result.status absent", async () => {
    if (skipIfMissing("red-envelope")) return;
    const tmp = mkdtempSync(join(tmpdir(), "red-envelope-"));
    const stateFile = join(tmp, "afk.state.toon");
    writeFileSync(stateFile, JSON.stringify({ current: {} }));
    const r = await runScript(
      "red-envelope",
      { RED_AFK_STATE_FILE: stateFile, RED_AFK_RESULT_STATUS: "fail" },
      "{}",
    );
    expect(r.code).toBe(0);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.current.result_status).toBe("fail");
  });
});

describe("red-validation parity", () => {
  it("emits skipped when RED_AFK_WORKSPACE is unset", async () => {
    if (skipIfMissing("red-validation")) return;
    const ctx = JSON.stringify({ issue: { number: 1 }, workspace: "/no-ws" });
    const r = await runScript("red-validation", {}, ctx);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.result.validation_status).toBe("skipped");
    expect(out.result.validation_summary).toBe("no workspace");
  });

  it("emits skipped when workspace has no package.json", async () => {
    if (skipIfMissing("red-validation")) return;
    const tmp = mkdtempSync(join(tmpdir(), "red-validation-"));
    const ctx = JSON.stringify({ issue: { number: 2 }, workspace: tmp });
    const r = await runScript(
      "red-validation",
      { RED_AFK_WORKSPACE: tmp },
      ctx,
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.result.validation_status).toBe("skipped");
    expect(out.result.validation_summary).toBe("no package.json");
  });

  it("merges validation_status into context preserving existing fields", async () => {
    if (skipIfMissing("red-validation")) return;
    const tmp = mkdtempSync(join(tmpdir(), "red-validation-"));
    // package.json with no scripts → all skipped → passes
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "test", scripts: {} }),
    );
    const ctx = JSON.stringify({
      issue: { number: 3 },
      workspace: tmp,
      merge_commit: { sha: "abc" },
    });
    const r = await runScript(
      "red-validation",
      { RED_AFK_WORKSPACE: tmp },
      ctx,
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(["passed", "failed", "skipped"]).toContain(
      out.result.validation_status,
    );
    // original context fields preserved
    expect(out.issue.number).toBe(3);
    expect(out.merge_commit.sha).toBe("abc");
  });
});
