/**
 * The rsp binary's argv, answered by the shared contract (ADR 0114, #2873).
 *
 * These assertions exist because the gap they cover was found by RUNNING the
 * binaries rather than by reading them: `rsp --version` returned a usage error
 * while `red-skills-dev` had had one all along, and grepping for the import of
 * the version helper suggested a coverage that did not exist. So the version and
 * help answers are asserted against a spawned process in a directory that never
 * opted in — the one situation where you actually need to ask which build is
 * answering, and the one a unit test of `main()` would not reproduce.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliUsageError, parseArgs, parseEntryIntent } from "../src/cli/args.js";
import { extractQueryArg } from "../src/output-levers.js";
import { cli, testChildEnv, tsxLoader } from "./cli.helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A directory with no `.red/`, no store, and no resident: rsp is inert here. */
async function unconfiguredRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-args-"));
  roots.push(root);
  return root;
}

function runRsp(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, ["--import", tsxLoader, cli, ...args], {
    cwd,
    env: testChildEnv({}),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("rsp version and help answers", () => {
  it("prints the build version for --version and -v before any config is read", async () => {
    const root = await unconfiguredRoot();

    for (const flag of ["--version", "-v"]) {
      const result = runRsp(root, [flag]);
      expect(result.status, `${flag}: ${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toMatch(/^rsp \S+ \S+$/);
    }

    // Nothing was provisioned to answer it: no store, no socket, no state.
    expect(await readdir(root)).toEqual([]);
  });

  it("prints structured build info for --version --json", async () => {
    const root = await unconfiguredRoot();
    const result = runRsp(root, ["--version", "--json"]);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ app: "rsp", version: expect.any(String) });
  });

  it("prints usage for --help and -h", async () => {
    const root = await unconfiguredRoot();

    for (const flag of ["--help", "-h"]) {
      const result = runRsp(root, [flag]);
      expect(result.status, `${flag}: ${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("usage: rsp <subcommand> [options]");
      expect(result.stdout).toContain("--version, -v");
    }
  });

  it("fails an unknown rsp flag with a message naming it", async () => {
    const root = await unconfiguredRoot();
    const result = runRsp(root, ["--bogus", "git", "status"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("unknown flag: --bogus");
  });

  it("fails an unknown subcommand with a message naming it", async () => {
    const root = await unconfiguredRoot();
    const result = runRsp(root, ["statz"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("unknown command: statz");
  });

  it("leaves --version to the wrapped command once a subcommand is routed", () => {
    expect(parseEntryIntent(["git", "--version"])).toEqual({ kind: "command" });
    expect(parseEntryIntent(["--version"])).toEqual({ kind: "version", json: false });
    expect(parseEntryIntent(["--version", "--json"])).toEqual({ kind: "version", json: true });
    expect(parseEntryIntent(["git", "--help"])).toEqual({ kind: "help" });
  });
});

describe("rsp argv routing", () => {
  it("routes the subcommand and keeps the wrapped command line verbatim", () => {
    const args = parseArgs(["git", "log", "--oneline", "-n", "5"]);

    expect(args.command).toBe("git");
    expect(args.positional).toEqual(["git", "log", "--oneline", "-n", "5"]);
    expect(args.level).toBe("lossless");
  });

  it("peels rsp's own flags from before and after the subcommand", () => {
    expect(parseArgs(["--terse", "git", "log"])).toMatchObject({
      command: "git",
      level: "terse",
      positional: ["git", "log"],
    });
    expect(parseArgs(["git", "log", "--brief"])).toMatchObject({
      command: "git",
      level: "brief",
      positional: ["git", "log"],
    });
  });

  it("reads --store-uri as a value flag in either spelling", () => {
    expect(parseArgs(["--store-uri", "file:///tmp/a", "stats"]).storeUri).toBe("file:///tmp/a");
    expect(parseArgs(["stats", "--store-uri=file:///tmp/b"]).storeUri).toBe("file:///tmp/b");
  });

  it("hands --query back to the wrapper that filters on it, but never to show", () => {
    expect(parseArgs(["git", "log", "--query", "fix"]).positional).toEqual(["git", "log", "--query", "fix"]);
    expect(parseArgs(["show", "el:abc", "--query", "fix"]).positional).toEqual(["show", "el:abc"]);
  });

  it("keeps the `--` separator and everything after it untouched", () => {
    const args = parseArgs(["--terse", "proxy", "--", "git log --brief"]);

    expect(args.level).toBe("terse");
    expect(args.positional).toEqual(["proxy", "--", "git log --brief"]);
  });

  it("names the bare invocation rather than leaving it unrouted", () => {
    expect(parseArgs([]).command).toBe("dashboard");
    expect(parseArgs([]).positional).toEqual([]);
  });

  it("rejects an unknown leading flag and a value flag with no value", () => {
    expect(() => parseArgs(["--bogus", "git"])).toThrow(CliUsageError);
    expect(() => parseArgs(["--bogus", "git"])).toThrow("unknown flag: --bogus");
    expect(() => parseArgs(["--query"])).toThrow("--query requires a value");
  });

  it("does not reject an unknown flag that belongs to the wrapped command", () => {
    expect(parseArgs(["git", "--bogus"]).positional).toEqual(["git", "--bogus"]);
  });

  it("leaves git's own `--` pathspec separator to git", () => {
    // rsp appends its filter after git's separator, and the wrapper takes it
    // back off there — so the pathspec reaches git and `--query` never does.
    const args = parseArgs(["--query", "fix", "git", "diff", "--", "src/a.ts"]);
    expect(args.positional).toEqual(["git", "diff", "--", "src/a.ts", "--query", "fix"]);
    expect(extractQueryArg(args.positional)).toEqual({
      argv: ["git", "diff", "--", "src/a.ts"],
      query: "fix",
    });
  });

  it("takes the elision handle from the routed argv", () => {
    expect(parseArgs(["show", "el:abc123"]).handle).toBe("el:abc123");
  });
});
