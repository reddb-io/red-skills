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

    expect(readme).toContain("99.8% decision-oracle capture");
    expect(readme).toContain("RTK 4.9%");
    expect(readme).toContain("Headroom 0.6%");
    expect(readme).toContain("docs/ARCHITECTURE.md");
    expect(readme).toContain("bench/README.md");
    expect(readme).toContain("wrappers");
    expect(readme).toContain("hook interception");
    expect(readme).toContain("resident");
    expect(readme).toContain("telemetry");
    expect(readme).toContain("rsp wait");
    expect(readme).toContain("three storage classes");
    expect(readme).toContain("derivable");
    expect(readme).toContain("re-executable");
    expect(readme).toContain("ephemeral");
    expect(readme).toContain("64 MiB physical cap");
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
      "three storage classes",
      "derivable",
      "re-executable",
      "ephemeral",
      "accounting lane",
      "physical cap",
      "compressed content-hash blobs",
      "rsp.wait.result",
      "--result-file",
      "--notify-timeout",
      "TERM",
      "KILL",
      "target_exit_code",
      "pins that run ID",
      "--probe-timeout",
      "delivery.status: pending",
      "recycled during a long wait",
      "stops at the repository boundary",
      "MAIN worktree",
      "the spool file is KEPT",
      "cannot prove cleanup",
    ]) {
      expect(architecture).toContain(required);
    }
  });

  it("links and pins the rsp troubleshooting playbooks", async () => {
    const ambient = await doc("generated/AMBIENT-SKILL.md");
    const troubleshooting = await doc("docs/TROUBLESHOOTING.md");

    expect(ambient).toContain("<supporting-info>");
    expect(ambient).toContain("apps/rsp/docs/TROUBLESHOOTING.md");
    expect(ambient).toContain("hook silence, resident/store splits, and store growth");

    for (const heading of [
      "## Hook silence",
      "## Resident/store split",
      "## Store growth",
      "### Symptom",
      "### Confirm",
      "### Recover",
      "### Root fix",
    ]) {
      expect(troubleshooting).toContain(heading);
    }
    for (const required of [
      "synthetic PreToolUse payload",
      "second enabled repo",
      "RSP_DEBUG=1",
      "rsp status",
      "rsp server",
      "idle byte-stability measurement",
      "live view",
      "physical-cap contract",
      "#1731",
      "#1726",
      "#1704",
    ]) {
      expect(troubleshooting).toContain(required);
    }
  });

  it("documents the resident-first diagnosis path and the fail-open behaviour per surface", async () => {
    const troubleshooting = await doc("docs/TROUBLESHOOTING.md");

    expect(troubleshooting).toContain("## Resident unreachable");
    expect(troubleshooting).toContain("Diagnose the resident first");
    // A resident that never started and a resident whose socket is unreachable
    // are different faults with different recoveries; the doc must separate them.
    expect(troubleshooting).toContain("never started");
    expect(troubleshooting).toContain("stale socket");
    // The exact observable behaviour of fail-open, surface by surface.
    expect(troubleshooting).toContain("costs the elision, never the command");
    expect(troubleshooting).toContain("empty snapshot");
    expect(troubleshooting).toContain("spooled bytes instead of minting");
    expect(troubleshooting).toContain("returns the payload it was handed");
  });

  it("never calls the rsp MCP server the canonical contact point", async () => {
    for (const path of [
      "README.md",
      "docs/ARCHITECTURE.md",
      "docs/TROUBLESHOOTING.md",
      "generated/AMBIENT-SKILL.md",
    ]) {
      const text = await doc(path);
      expect(text).not.toMatch(/MCP[^.\n]{0,80}\b(canonical|sole)\b/i);
      expect(text).not.toMatch(/MCP[^.\n]{0,80}contact point/i);
    }
  });

  it("explains how to run and interpret the two-axis benchmark", async () => {
    const bench = await doc("bench/README.md");

    expect(bench).toContain("pnpm --filter @reddb-io/rsp bench:two-axis");
    expect(bench).toContain("pnpm --filter @reddb-io/rsp bench:two-axis:check");
    expect(bench).toContain("pnpm --filter @reddb-io/rsp bench:boundary");
    expect(bench).toContain("rsp-command-boundary.md");
    expect(bench).toContain("decision-oracle capture");
    expect(bench).toContain("fidelity-first score");
    expect(bench).toContain("bench/results/rsp-two-axis.md");
    expect(bench).toContain("RTK");
    expect(bench).toContain("Headroom");
  });
});
