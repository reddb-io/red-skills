import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseRecords } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RSP_BYTE_BUDGET,
  DEFAULT_RSP_EPHEMERAL_TTL_HOURS,
  DEFAULT_RSP_TELEMETRY_BYTE_BUDGET,
  DEFAULT_RSP_TELEMETRY_TTL_DAYS,
  DEFAULT_RSP_TTL_DAYS,
} from "../src/config.js";
import { resolveResidentPaths } from "../src/resident-client.js";
import { sendResidentRequest } from "../src/resident-protocol.js";
import { telemetrySpoolPath } from "../src/telemetry.js";
import { rewriteProxyCommandLine } from "../src/proxy.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-proxy-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rsp proxy segment recognition", () => {
  it("rewrites recognized stdout-tail segments and leaves pipeline producers raw", () => {
    expect(rewriteProxyCommandLine("cd apps && git log", "terse", ["rsp"])).toMatchObject({
      commandLine: "cd apps && rsp --terse git log",
      matches: [expect.objectContaining({ capabilityId: "git:log", command: "git log" })],
    });
    expect(rewriteProxyCommandLine("git branch -av", "brief", ["rsp"])).toMatchObject({
      commandLine: "rsp --brief git branch -av",
      matches: [expect.objectContaining({ capabilityId: "git:branch:av", command: "git branch -av" })],
    });
    expect(rewriteProxyCommandLine("printf 'x\\n' | grep x", "brief", ["rsp"])).toMatchObject({
      commandLine: "printf 'x\\n' | grep x",
      matches: [],
    });
    expect(rewriteProxyCommandLine("git log | tail -5", "brief", ["rsp"])).toMatchObject({
      commandLine: "git log | tail -5",
      matches: [],
    });
    expect(rewriteProxyCommandLine("printf before; gh pr list --limit 5", "brief", ["rsp"])).toMatchObject({
      commandLine: "printf before; rsp --brief gh pr list --limit 5",
      matches: [expect.objectContaining({ capabilityId: "gh:pr:list", command: "gh pr list --limit 5" })],
    });
    expect(rewriteProxyCommandLine("printf before; gh pr list --json number,title --jq '.[] | .number'", "brief", ["rsp"])).toMatchObject({
      commandLine: "printf before; gh pr list --json number,title --jq '.[] | .number'",
      matches: [
        expect.objectContaining({
          command: "gh pr list --json number,title --jq '.[] | .number'",
          commandFamily: "gh pr list json-jq",
          decision: "passed",
          reason: "lossless-gh-json-jq",
        }),
      ],
    });
    expect(rewriteProxyCommandLine(
      "git show --format=%s --no-patch HEAD > release.txt && git fetch origin && git switch main && git merge topic && git branch -d topic",
      "brief",
      ["rsp"],
    )).toMatchObject({
      commandLine: "rsp --brief git show --format=%s --no-patch HEAD > release.txt && git fetch origin && git switch main && git merge topic && git branch -d topic",
      matches: [expect.objectContaining({ capabilityId: "git:show", command: "git show --format=%s --no-patch HEAD > release.txt" })],
    });
  });

  it("rewrites proxy segments via bundled entrypoint when rsp is not on PATH", () => {
    const prefix = ["/fake/node", "/fake/rsp.bundle.mjs"];
    expect(rewriteProxyCommandLine("cd apps && git log", "terse", prefix)).toMatchObject({
      commandLine: "cd apps && /fake/node /fake/rsp.bundle.mjs --terse git log",
      matches: [expect.objectContaining({ capabilityId: "git:log", command: "git log" })],
    });
    expect(rewriteProxyCommandLine("printf before; gh pr list --limit 5", "brief", prefix)).toMatchObject({
      commandLine: "printf before; /fake/node /fake/rsp.bundle.mjs --brief gh pr list --limit 5",
      matches: [expect.objectContaining({ capabilityId: "gh:pr:list", command: "gh pr list --limit 5" })],
    });
  });

  it("summarizes a contributed tail segment with a recoverable elision handle", async () => {
    const root = await tempRoot();
    const bundle = await ensureRspBundle();
    const setup = spawnSync(process.execPath, [bundle, "setup"], { cwd: root, encoding: "utf8" });
    expect(setup.status, `${setup.stdout}${setup.stderr}`).toBe(0);
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n  proxy:\n    enabled: true\n", "utf8");
    await installRspShim(root, bundle);
    initGitRepo(root);
    const paths = resolveResidentPaths(root);
    const server = execFile(process.execPath, [
      bundle,
      "server",
      "--socket",
      paths.socketPath,
      "--pid-file",
      paths.pidPath,
      "--store-uri",
      `file://${join(root, ".red", "state", "red-skills.rdb")}`,
      "--ttl-days",
      String(DEFAULT_RSP_TTL_DAYS),
      "--ephemeral-ttl-hours",
      String(DEFAULT_RSP_EPHEMERAL_TTL_HOURS),
      "--byte-budget",
      String(DEFAULT_RSP_BYTE_BUDGET),
      "--telemetry-ttl-days",
      String(DEFAULT_RSP_TELEMETRY_TTL_DAYS),
      "--telemetry-byte-budget",
      String(DEFAULT_RSP_TELEMETRY_BYTE_BUDGET),
      "--telemetry-drain-timeout-ms",
      "2000",
      "--idle-ms",
      "5000",
      "--registry",
      paths.registryPath,
    ], { cwd: root });
    await waitForResident(paths.socketPath);

    const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` };
    try {
      const proxied = spawnSync(process.execPath, [
        bundle,
        "--terse",
        "proxy",
        "--",
        "printf 'prefix\\n'; git log",
      ], { cwd: root, env, encoding: "utf8" });

      expect(proxied.status, `${proxied.stdout}${proxied.stderr}`).toBe(0);
      expect(proxied.stdout).toContain("prefix\n");
      const handle = /rsp show (el:[a-z0-9]+)/.exec(proxied.stdout)?.[1];
      expect(handle, `${proxied.stdout}${proxied.stderr}`).toBeTruthy();

      const recovered = spawnSync(process.execPath, [bundle, "show", handle!], {
        cwd: root,
        env,
        encoding: "utf8",
      });
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(recovered.stdout).toContain("commits");

      await expect(readSpoolEvents(root)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          hook: "proxy",
          command: "git log",
          command_family: "git log",
          decision: "contributed",
          capability_id: "git:log",
        }),
      ]));
    } finally {
      await shutdownResident(paths.socketPath);
      await waitForExit(server);
    }
  }, 30_000);

  it("executes gh json/jq selector segments byte-identically and records a lossless pass", async () => {
    const root = await tempRoot();
    const bundle = await ensureRspBundle();
    const setup = spawnSync(process.execPath, [bundle, "setup"], { cwd: root, encoding: "utf8" });
    expect(setup.status, `${setup.stdout}${setup.stderr}`).toBe(0);
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin", "gh"), "#!/usr/bin/env sh\nprintf '%s\\n' '[{\"number\":1747,\"title\":\"lossless\"}]'\n", "utf8");
    await chmod(join(root, "bin", "gh"), 0o755);

    const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` };
    const proxied = spawnSync(process.execPath, [
      bundle,
      "--brief",
      "proxy",
      "--",
      "gh pr list --json number,title --jq '.[0]'",
    ], { cwd: root, env, encoding: "utf8" });

    expect(proxied.status, `${proxied.stdout}${proxied.stderr}`).toBe(0);
    expect(proxied.stdout).toBe("[{\"number\":1747,\"title\":\"lossless\"}]\n");
    await expect(readSpoolEvents(root)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        hook: "proxy",
        command: "gh pr list --json number,title --jq '.[0]'",
        command_family: "gh pr list json-jq",
        decision: "passed",
        reason: "lossless-gh-json-jq",
      }),
    ]));
  }, 30_000);
});

async function readSpoolEvents(root: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(telemetrySpoolPath(root), "utf8").catch(() => "");
  const rows: Array<Record<string, unknown>> = [];
  let header = "";
  for (const line of raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    if (/^\[(?:\d*)\]\{[^}]+\}:$/.test(line)) {
      header = line;
      continue;
    }
    if (!header) continue;
    for (const row of parseRecords(`${header}\n${line}\n`)) {
      if (!isRecord(row)) continue;
      if (typeof row.event_json !== "string") {
        const { spool_id: _spoolId, ...event } = row;
        if (typeof event.collection === "string") rows.push(event);
        continue;
      }
      const event = JSON.parse(row.event_json) as unknown;
      if (isRecord(event)) rows.push(event);
    }
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function installRspShim(root: string, bundle: string): Promise<void> {
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const shim = [
    "#!/usr/bin/env bash",
    `exec "${process.execPath}" "${bundle}" "$@"`,
    "",
  ].join("\n");
  await writeFile(join(binDir, "rsp"), shim, "utf8");
  await chmod(join(binDir, "rsp"), 0o755);
}

async function ensureRspBundle(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const appRoot = resolve(here, "..");
  const repoRoot = resolve(appRoot, "..", "..");
  const bundle = join(repoRoot, "dist", "rsp.bundle.min.mjs");
  await execFileAsync(process.execPath, [
    join(repoRoot, "scripts", "bundle-app.mjs"),
    "--entry",
    "src/cli.ts",
    "--outfile",
    "../../dist/rsp.bundle.min.mjs",
    "--asset",
    "rsp.bundle.min.mjs",
    "--minify",
    "--reddb-from-package",
  ], { cwd: appRoot });
  return bundle;
}

function initGitRepo(root: string): void {
  expect(spawnSync("git", ["init"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["config", "user.email", "rsp@example.test"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["config", "user.name", "RSP Test"], { cwd: root }).status).toBe(0);
  for (let index = 0; index < 5; index += 1) {
    const file = join(root, `file-${index}.txt`);
    spawnSync("sh", ["-c", `printf 'line ${index}\\n' > "$1"`, "sh", file], { cwd: root });
    expect(spawnSync("git", ["add", `file-${index}.txt`], { cwd: root }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", `commit ${index}`], { cwd: root }).status).toBe(0);
  }
}

async function waitForResident(socketPath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const alive = await sendResidentRequest({ socketPath, timeoutMs: 100 }, {
      id: "proxy-test-ping",
      op: "ping",
    }).then((response) => response.ok, () => false);
    if (alive) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("resident did not start");
}

async function shutdownResident(socketPath: string): Promise<void> {
  await sendResidentRequest({ socketPath, timeoutMs: 500 }, {
    id: "proxy-test-shutdown",
    op: "handover",
    clientVersion: "proxy-test",
  }).catch(() => null);
}

async function waitForExit(child: ReturnType<typeof execFile>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`resident exited ${code}`)));
    child.once("error", reject);
  });
}
