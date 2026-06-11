import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("benchmark-code-understanding CLI", () => {
  test("dry-run emits planned records and a guarded report", () => {
    const result = run(["run", "--dry-run", "--arms", "none,redskills", "--runs", "1"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"schema_version": "redskills.code_understanding_bench.report.v1"');
    expect(result.stdout).toContain('"run_count": 8');
    expect(result.stdout).toContain("redskills-token-savings");
    expect(result.stdout).toContain("Code Understanding Benchmark");
  });

  test("dry-run can fail on unsupported claims for CI claim gates", () => {
    const result = run([
      "run",
      "--dry-run",
      "--arms",
      "none,redskills",
      "--runs",
      "1",
      "--fail-on-unsupported-claims",
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("redskills-token-savings");
  });

  test("doctor emits the stable schema in JSON mode", () => {
    const result = run(["doctor", "--json"]);

    expect([0, 1]).toContain(result.status);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as { schema_version: string; checks: unknown[] };
    expect(parsed.schema_version).toBe("redskills.code_understanding_bench.doctor.v1");
    expect(parsed.checks.length).toBeGreaterThan(0);
  });
});
