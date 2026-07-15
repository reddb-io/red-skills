import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function doc(relativePath: string): Promise<string> {
  return await readFile(join(packageRoot, relativePath), "utf8");
}

describe("rsp docs surface", () => {
  it("describes the shipped rsp surface with stable contract headings", async () => {
    const readme = await doc("README.md");

    expect(readme).toContain("99.4% decision-oracle capture");
    expect(readme).toContain("RTK 4.9%");
    expect(readme).toContain("Headroom 0.6%");
    expect(readme).toContain("docs/ARCHITECTURE.md");
    expect(readme).toContain("bench/README.md");
    expect(readme).toContain("wrappers");
    expect(readme).toContain("hook interception");
    expect(readme).toContain("resident");
    expect(readme).toContain("telemetry");
    expect(readme).toContain("rsp wait");
    for (const heading of [
      "## What rsp Does",
      "## Permanent Proxy Model",
      "## Contribution Metrics",
      "## Recovery Model",
      "## Resident and Telemetry",
      "## Configuration",
    ]) {
      expect(readme).toContain(heading);
    }
    expect(readme).not.toMatch(/land in later slices|currently carries only|will ship/i);
  });

  it("documents resident lifecycle, telemetry, elisions, wait, proxy, and fail-open behavior", async () => {
    const architecture = await doc("docs/ARCHITECTURE.md");

    for (const heading of [
      "## CLI and Wrappers",
      "## Permanent Proxy Routing",
      "## Resident Lifecycle",
      "## Socket Protocol",
      "## Elision Store and Handles",
      "## Telemetry Chain",
      "## Stats, Gains, and Statusline Summary",
      "## Wait Registry",
      "## Hook Interception",
      "## Fail-Open Invariant",
    ]) {
      expect(architecture).toContain(heading);
    }
    for (const required of [
      "socket",
      "single embedded writer",
      "idle shutdown",
      "watchdog",
      "PID registry",
      "version handover",
      "spool",
      "drain",
      "store",
      "gains",
      "statusline summary",
      "el:",
      "wait registry",
      "fail-open",
      "rsp.proxy.enabled",
      "proxy:universal",
      "lossless-gh-json-jq",
      "contribution_rate",
      "failed-open",
    ]) {
      expect(architecture).toContain(required);
    }
  });

  it("explains how to run and interpret the two-axis benchmark", async () => {
    const bench = await doc("bench/README.md");

    expect(bench).toContain("pnpm --filter @reddb-io/rsp bench:two-axis");
    expect(bench).toContain("pnpm --filter @reddb-io/rsp bench:two-axis:check");
    expect(bench).toContain("decision-oracle capture");
    expect(bench).toContain("fidelity-first score");
    expect(bench).toContain("bench/results/rsp-two-axis.md");
    expect(bench).toContain("RTK");
    expect(bench).toContain("Headroom");
  });
});
