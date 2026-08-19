/**
 * CLI smoke tests — the binary itself, spawned.
 *
 * The gap this closes was found by testing the binary rather than reading it:
 * importing a version helper is not exposing it, so these tests run the entry
 * module the way a shell does and read what it actually prints.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");
const ENTRY = resolve(REPO, "apps/mcp-navigator/src/index.ts");

// Spawned directly rather than through `pnpm`, whose recursive exec wrapper
// rewrites a non-zero child status to 1 — and the exit code IS the contract
// here. pnpm's isolated layout keeps the bin package-local; a hoisted install
// puts it at the repo root.
const TSX = [
  resolve(REPO, "apps/mcp-navigator/node_modules/.bin/tsx"),
  resolve(REPO, "node_modules/.bin/tsx"),
].find((candidate) => existsSync(candidate));

function runCodeNav(
  args: string[],
  env: Record<string, string | undefined> = {},
): { status: number; stdout: string; stderr: string } {
  if (TSX === undefined) throw new Error("tsx not installed; run `pnpm install`");
  const r = spawnSync(TSX, [ENTRY, ...args], {
    cwd: REPO,
    encoding: "utf8",
    // No stdin: the serve path would block on the stdio transport, so a test
    // that hangs here is a test catching a version answer that came too late.
    input: "",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("code-nav (CLI smoke)", () => {
  it("prints the build version on --version, -v, and the version command", () => {
    for (const argv of [["--version"], ["-v"], ["version"]]) {
      const r = runCodeNav(argv);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^navigator \S+ \S+\n$/);
    }
  });

  it("prints the structured build info on --version --json", () => {
    const r = runCodeNav(["--version", "--json"]);
    expect(r.status).toBe(0);
    const info = JSON.parse(r.stdout) as { app: string; version: string; gitSha: string };
    expect(info.app).toBe("navigator");
    expect(typeof info.version).toBe("string");
    expect(typeof info.gitSha).toBe("string");
  });

  it("answers --version without loading the registry or opening a session", () => {
    // An override that cannot parse would warn on stderr on the serve path, and
    // the transport would announce itself. Neither may happen for a version ask.
    const r = runCodeNav(["--version"], { CODE_NAV_SERVERS: "{not json" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^navigator /);
    expect(r.stderr).not.toMatch(/CODE_NAV_SERVERS/);
    expect(r.stderr).not.toMatch(/MCP ready/);
  });

  it("prints usage on --help and -h", () => {
    for (const flag of ["--help", "-h"]) {
      const r = runCodeNav([flag]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Usage:");
      expect(r.stdout).toContain("--version");
    }
  });

  it("fails with exit 2 naming an unknown flag", () => {
    const r = runCodeNav(["--bogus"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown flag '--bogus'/);
  });

  it("fails with exit 2 naming a typo'd command", () => {
    const r = runCodeNav(["serv"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown command 'serv'/);
  });
});
