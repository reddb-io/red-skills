import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-privacy-cli-"));
  roots.push(root);
  return root;
}

describe("memory privacy CLI", () => {
  test("scans graph memory read-only and writes redacted export artifacts", async () => {
    const root = await tempRoot();
    const init = runMemory(["init", "--mode", "graph", "--root", root, "--yes"]);
    expect(init.status, init.stderr).toBe(0);

    const syntheticSecret = "sk-test_1234567890abcdefghijklmnopqrstuv";
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const storeSecret = runMemory([
      "store",
      `Deploy token is ${syntheticSecret} and AWS access key is ${awsKey}.`,
      "--root",
      root,
    ]);
    expect(storeSecret.status, storeSecret.stderr).toBe(0);

    const storeSafe = runMemory([
      "store",
      "Release notes must describe user-visible changes before internal cleanup.",
      "--root",
      root,
    ]);
    expect(storeSafe.status, storeSafe.stderr).toBe(0);

    const scan = runMemory(["privacy", "scan", "--root", root, "--json"]);
    expect(scan.status, scan.stderr).toBe(0);
    const report = JSON.parse(scan.stdout) as {
      readOnly: boolean;
      mutated: boolean;
      findings: Array<{ kind: string; redacted: string; excerpt: string }>;
    };
    expect(report.readOnly).toBe(true);
    expect(report.mutated).toBe(false);
    expect(report.findings.map((finding) => finding.kind)).toEqual(
      expect.arrayContaining(["openai-token", "aws-access-key-id"]),
    );
    expect(report.findings.map((finding) => finding.redacted)).toContain("[REDACTED:openai-token]");
    expect(JSON.stringify(report)).not.toContain(syntheticSecret);
    expect(JSON.stringify(report)).not.toContain(awsKey);

    const human = runMemory(["privacy", "scan", "--root", root]);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain("Read-only privacy scan: no memory, graph, note, or export files were mutated.");

    const outDir = join(root, "redacted-export");
    const exported = runMemory(["privacy", "export", outDir, "--root", root, "--json"]);
    expect(exported.status, exported.stderr).toBe(0);
    const exportedBody = JSON.parse(exported.stdout) as {
      redacted: boolean;
      findings: number;
      result: { jsonPath: string; htmlPath: string; auditPath: string; nodes: number };
    };
    expect(exportedBody.redacted).toBe(true);
    expect(exportedBody.findings).toBeGreaterThanOrEqual(2);
    expect(exportedBody.result.nodes).toBe(2);

    const artifacts = await Promise.all([
      readFile(exportedBody.result.jsonPath, "utf8"),
      readFile(exportedBody.result.htmlPath, "utf8"),
      readFile(exportedBody.result.auditPath, "utf8"),
    ]);
    for (const artifact of artifacts) {
      expect(artifact).not.toContain(syntheticSecret);
      expect(artifact).not.toContain(awsKey);
      expect(artifact).toContain("[REDACTED:");
    }
    expect(artifacts[0]).toContain("Release notes must describe user-visible changes");
  }, TIMEOUT);
});
