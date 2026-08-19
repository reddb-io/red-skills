import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

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

function runMemory(args: string[], cwd = pkgRoot) {
  return runBinary(cliEntry, args, cwd);
}

function runMemoryMcp(args: string[], cwd = pkgRoot) {
  return runBinary(mcpEntry, args, cwd);
}

async function emptyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-cli-args-contract-"));
  dirs.push(dir);
  return dir;
}

describe("memory CLI argument contract", () => {
  test("--version states the build version", () => {
    const result = runMemory(["--version"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^memory \S+ \S+$/);
  });

  test("-v answers exactly like --version", () => {
    const short = runMemory(["-v"]);
    const long = runMemory(["--version"]);

    expect(short.status, short.stderr).toBe(0);
    expect(short.stdout).toBe(long.stdout);
  });

  test("--version --json states the structured build info", () => {
    const result = runMemory(["--version", "--json"]);

    expect(result.status, result.stderr).toBe(0);
    const info = JSON.parse(result.stdout) as { app: string; version: string; gitSha: string };
    expect(info.app).toBe("memory");
    expect(info.version).toBeTruthy();
    expect(info.gitSha).toBeTruthy();
  });

  test("the version command answers the same fact", () => {
    const command = runMemory(["version"]);
    const flag = runMemory(["--version"]);

    expect(command.status, command.stderr).toBe(0);
    expect(command.stdout).toBe(flag.stdout);
  });

  test("the version answer needs no config, no store, and no memory root", async () => {
    const dir = await emptyDir();

    const result = runMemory(["--version"], dir);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^memory \S+ \S+$/);
    // Nothing was initialised to answer it: no `.red/`, no notes dir, no store.
    expect(await readdir(dir)).toEqual([]);
  });

  test("--help and -h print usage", () => {
    for (const flag of ["--help", "-h"]) {
      const result = runMemory([flag]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("memory — governed operational memory for code agents");
    }
  });

  test("a bare invocation prints usage", () => {
    const result = runMemory([]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("memory — governed operational memory for code agents");
  });

  test("an unknown flag fails naming it as a flag, not as a command", () => {
    const result = runMemory(["--not-a-flag"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown flag: --not-a-flag");
  });

  test("a typo'd command fails with a message naming it", () => {
    const result = runMemory(["recal", "topic"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("recal");
  });

  test("a named command is never hijacked by a trailing version flag", async () => {
    const dir = await emptyDir();

    // `--version` is the binary's own flag, answered when no command is named.
    // A command that was named runs; the flag belongs to the command from there.
    const result = runMemory(["recall", "topic", "--root", dir, "--version"], dir);

    expect(result.stdout.trim()).not.toMatch(/^memory \S+ \S+$/);
  });

  test("the MCP server answers the same version questions", () => {
    for (const args of [["--version"], ["-v"], ["version"]]) {
      const result = runMemoryMcp(args);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toMatch(/^memory-mcp \S+ \S+$/);
    }

    const json = runMemoryMcp(["--version", "--json"]);
    expect(json.status, json.stderr).toBe(0);
    expect((JSON.parse(json.stdout) as { app: string }).app).toBe("memory-mcp");
  });

  test("the MCP server answers usage without opening a store (#2918)", () => {
    for (const args of [["--help"], ["-h"], ["help"]]) {
      const result = runMemoryMcp(args);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Usage: memory-mcp");
      expect(result.stdout).toContain("serve");
    }
  });

  test("no CLI module walks argv by hand", async () => {
    const cliDir = resolve(__dirname, "..", "src", "cli");
    const offenders: string[] = [];

    for (const file of await readdir(cliDir)) {
      if (!file.endsWith(".ts")) continue;
      const source = await readFile(join(cliDir, file), "utf8");
      if (/argv\[/.test(source)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
