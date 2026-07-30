/**
 * The `brain` binaries' argument contract (ADR 0114).
 *
 * Testing the binary rather than reading it is the point: importing a version
 * helper is not exposing one, and a hand-rolled parser's answers — what counts
 * as a flag, what happens to an unknown one, whether `-v` is version or
 * verbose — are only visible from the outside.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  BRAIN_USAGE,
  CAPTURE_FLAGS,
  parseBrainFlags,
  routeBrainCommand,
  SEARCH_FLAGS,
} from "../src/cli-args.js";

const TIMEOUT = 60_000;
const require_ = createRequire(import.meta.url);
const tsxLoader = require_.resolve("tsx");
const cliEntry = resolve(__dirname, "..", "src", "cli.ts");
const mcpEntry = resolve(__dirname, "..", "src", "mcp-server.ts");
const pkgRoot = resolve(__dirname, "..");
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runBinary(entry: string, args: string[], cwd = pkgRoot) {
  return spawnSync(process.execPath, ["--import", tsxLoader, entry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

function runBrain(args: string[], cwd = pkgRoot) {
  return runBinary(cliEntry, args, cwd);
}

function runBrainMcp(args: string[], cwd = pkgRoot) {
  return runBinary(mcpEntry, args, cwd);
}

async function emptyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "brain-cli-args-contract-"));
  dirs.push(dir);
  return dir;
}

describe("brain CLI argument contract", () => {
  test("--version states the build version", () => {
    const result = runBrain(["--version"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^brain \S+ \S+$/);
  });

  test("-v answers exactly like --version", () => {
    const short = runBrain(["-v"]);
    const long = runBrain(["--version"]);

    expect(short.status, short.stderr).toBe(0);
    expect(short.stdout).toBe(long.stdout);
  });

  test("--version --json states the structured build info", () => {
    const result = runBrain(["--version", "--json"]);

    expect(result.status, result.stderr).toBe(0);
    const info = JSON.parse(result.stdout) as { app: string; version: string; gitSha: string };
    expect(info.app).toBe("brain");
    expect(info.version).toBeTruthy();
    expect(info.gitSha).toBeTruthy();
  });

  test("the version command answers the same fact", () => {
    const command = runBrain(["version"]);
    const flag = runBrain(["--version"]);

    expect(command.status, command.stderr).toBe(0);
    expect(command.stdout).toBe(flag.stdout);
  });

  test("the version answer needs no config, no store, and no brain root", async () => {
    const dir = await emptyDir();

    const result = runBrain(["--version"], dir);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^brain \S+ \S+$/);
    // Nothing was initialised to answer it: no `.red/`, no store, no socket.
    expect(await readdir(dir)).toEqual([]);
  });

  test("--help and -h print usage", () => {
    for (const flag of ["--help", "-h"]) {
      const result = runBrain([flag]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("brain commands:");
    }
  });

  test("a bare invocation prints usage", () => {
    const result = runBrain([]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("brain commands:");
  });

  test("an unknown flag fails naming it as a flag, not as a command", () => {
    const result = runBrain(["--not-a-flag"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--not-a-flag");
    expect(result.stderr).not.toContain("unknown brain command");
  });

  test("an unknown short flag is named the way it was typed", () => {
    const result = runBrain(["-z"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("-z");
  });

  test("a typo'd command fails with a message naming it", () => {
    const result = runBrain(["captur", "text"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("captur");
  });

  test("a command's own unknown flag names the flag", () => {
    const result = runBrain(["search", "topic", "--bogus"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--bogus");
  });

  test("the brain-mcp server answers the same version questions", () => {
    for (const args of [["--version"], ["-v"], ["version"]]) {
      const result = runBrainMcp(args);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toMatch(/^brain-mcp \S+ \S+$/);
    }

    const json = runBrainMcp(["--version", "--json"]);
    expect(json.status, json.stderr).toBe(0);
    expect((JSON.parse(json.stdout) as { app: string }).app).toBe("brain-mcp");
  });

  test("the CLI entry walks no argv by hand", async () => {
    const source = await readFile(cliEntry, "utf8");

    expect(source).not.toMatch(/argv\[/);
    expect(source).not.toMatch(/startsWith\("--"\)/);
  });
});

describe("brain argument schemas", () => {
  test("routes a command and hands the rest of argv to it", () => {
    expect(routeBrainCommand(["search", "topic", "--limit", "3"])).toEqual({
      command: "search",
      args: ["topic", "--limit", "3"],
    });
  });

  test("routes aliases onto their canonical command", () => {
    expect(routeBrainCommand(["query", "topic"]).command).toBe("think");
    expect(routeBrainCommand(["kpis"]).command).toBe("kpi");
  });

  test("routes a bare or flag-led invocation to help without dropping flags", () => {
    expect(routeBrainCommand([])).toEqual({ command: "help", args: [] });
    expect(routeBrainCommand(["--version"])).toEqual({ command: "help", args: ["--version"] });
  });

  test("names a typo'd command rather than guessing a verb", () => {
    expect(() => routeBrainCommand(["captur"])).toThrow(/captur/);
  });

  test("accepts long, short-form, and inline spellings alike", () => {
    expect(parseBrainFlags(["--limit", "3"], SEARCH_FLAGS).values.limit).toBe(3);
    expect(parseBrainFlags(["--limit=3"], SEARCH_FLAGS).values.limit).toBe(3);
  });

  test("keeps positionals apart from flags", () => {
    const parsed = parseBrainFlags(["hello", "world", "--title", "T"], CAPTURE_FLAGS);

    expect(parsed.positionals).toEqual(["hello", "world"]);
    expect(parsed.values.title).toBe("T");
  });

  test("accumulates repeated --tag occurrences in order", () => {
    expect(parseBrainFlags(["--tag", "a", "--tag", "b"], CAPTURE_FLAGS).values.tag).toEqual([
      "a",
      "b",
    ]);
  });

  test("fails when a value flag is missing its value", () => {
    expect(() => parseBrainFlags(["--title"], CAPTURE_FLAGS)).toThrow(/--title requires a value/);
  });

  test("fails on a non-numeric count naming the flag", () => {
    expect(() => parseBrainFlags(["--limit", "many"], SEARCH_FLAGS)).toThrow(
      /--limit must be a number/,
    );
  });

  test("usage states the binary's own flags, not only its commands", () => {
    for (const flag of ["--version", "--json", "--help"]) {
      expect(BRAIN_USAGE).toContain(flag);
    }
  });
});
