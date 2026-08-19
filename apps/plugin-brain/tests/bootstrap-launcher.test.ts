import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
// @ts-expect-error — the dependency-free .mjs launcher ships without type declarations
import { platformKey } from "../../../plugins/brain/scripts/bootstrap.mjs";

// End-to-end launcher behaviour for the Brain runtime (ADR 0084 tracer, #1032).
//
// These tests spawn the real `bootstrap.mjs` — the committed launcher that
// marketplace-installed copies run in place of built output — against a local
// release server, and prove the distribution guarantees the memory tracer slice
// established (#1030):
//
//   1. cache hit         → a warm cache runs REAL runtime from disk, zero network
//   2. cache miss + fetch → the SessionStart resolve point downloads + delegates
//   3. gate-inert        → a directory that never opted in makes zero network
//   4. offline degrade   → a failed first fetch no-ops and leaves a marker
//   5. ordering          → a render/hot-path hook never fetches on a cold cache
//
// The launcher resolves the plugin version from CLAUDE_PLUGIN_ROOT and every
// asset URL from RED_BRAIN_RELEASE_BASE, so no real network is ever touched.
// RED_BRAIN_REPO_ROOT points the dev/pre-release local fallback at an empty dir,
// so these tests simulate an installed copy with no repo checkout (the only
// place the release/degrade paths — not the local fallback — apply).

const BOOTSTRAP = resolve(__dirname, "../../../plugins/brain/scripts/bootstrap.mjs");
const PLUGIN_ROOT = resolve(__dirname, "../../../plugins/brain");
const VERSION: string = JSON.parse(
  readFileSync(resolve(PLUGIN_ROOT, ".claude-plugin/plugin.json"), "utf8"),
).version;
const RED_KEY: string = platformKey(process.platform, process.arch);

// A fake runtime that announces itself so a test can prove the real cached
// runtime — not a no-op — executed.
const CLI_BODY = `#!/usr/bin/env node
process.stdout.write("BRAIN-RUNTIME-RAN " + process.argv.slice(2).join(" ") + "\\n");
`;
const MCP_BODY = "#!/usr/bin/env node\nprocess.exit(0);\n";
const RED_BODY = "#!/bin/sh\nexit 0\n";

const sha = (body: string) => createHash("sha256").update(body).digest("hex");

/** npm registry metadata advertising a set of published versions (ADR 0091). */
function registryMetadata(versions: string[]): string {
  const map: Record<string, unknown> = {};
  for (const v of versions) map[v] = {};
  return JSON.stringify({ "dist-tags": { latest: versions[versions.length - 1] }, versions: map });
}

function manifestJson(version = VERSION): string {
  return JSON.stringify({
    schema: "red.brain.runtime.v1",
    version,
    cli: { asset: "brain.bundle.min.mjs", sha256: sha(CLI_BODY) },
    mcp: { asset: "brain-mcp.bundle.min.mjs", sha256: sha(MCP_BODY) },
    reddb: {
      repo: "reddb-io/reddb",
      tag: "v0.0.0-test",
      assets: { [RED_KEY]: { asset: `red-${RED_KEY}`, sha256: sha(RED_BODY) } },
    },
  });
}

interface Release {
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * A working release server that serves the fake runtime assets by basename, plus
 * the npm registry metadata for self-update version discovery (ADR 0091). No
 * sigstore signature is served — client signature verification was removed.
 */
async function startRelease(opts: { version?: string; versions?: string[] } = {}): Promise<Release> {
  let n = 0;
  const manifest = manifestJson(opts.version);
  const files: Record<string, string> = {
    "brain-runtime-manifest.json": manifest,
    "brain.bundle.min.mjs": CLI_BODY,
    "brain-mcp.bundle.min.mjs": MCP_BODY,
    [`red-${RED_KEY}`]: RED_BODY,
    "@reddb-io%2Fred-skills": registryMetadata(opts.versions ?? [VERSION]),
  };
  const { url, close } = await listen((req, res) => {
    n += 1;
    const name = (req.url ?? "").split("?")[0].split("/").pop() ?? "";
    const body = files[name];
    if (body === undefined) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = 200;
    res.end(body);
  });
  return { url, hits: () => n, close };
}

/** A release server that fails every request — the offline / outage case. */
async function startFailingRelease(): Promise<Release> {
  let n = 0;
  const { url, close } = await listen((_req, res) => {
    n += 1;
    res.statusCode = 500;
    res.end("boom");
  });
  return { url, hits: () => n, close };
}

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeCacheDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "brain-cache-"));
  scratch.push(d);
  return d;
}

/** An empty dir the local fallback resolves against — no bundle, no TS source. */
async function emptyRepoRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "brain-norepo-"));
  scratch.push(d);
  return d;
}

async function enabledCwd(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "brain-on-"));
  scratch.push(d);
  await mkdir(join(d, ".red"), { recursive: true });
  await writeFile(join(d, ".red", "config.yaml"), "plugins:\n  brain:\n    enabled: true\n");
  return d;
}

async function disabledCwd(): Promise<string> {
  // A temp dir with no `.red/config.yaml` in any ancestor — the gate (ADR 0067)
  // treats brain as disabled.
  const d = await mkdtemp(join(tmpdir(), "brain-off-"));
  scratch.push(d);
  return d;
}

/** Pre-populate the version-keyed cache with the fake runtime (a warm cache). */
async function warmCache(cacheDir: string): Promise<void> {
  const dir = join(cacheDir, "reddb-brain", VERSION);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "brain-cli.mjs"), CLI_BODY);
  await writeFile(join(dir, "brain-mcp.mjs"), MCP_BODY);
  const red = join(dir, process.platform === "win32" ? "red.exe" : "red");
  await writeFile(red, RED_BODY);
  await chmod(red, 0o755);
}

const cliPath = (cacheDir: string) =>
  join(cacheDir, "reddb-brain", VERSION, "brain-cli.mjs");
const markerPath = (cacheDir: string) =>
  join(cacheDir, "reddb-brain", "runtime-degraded.json");
const pointerPath = (cacheDir: string) =>
  join(cacheDir, "reddb-brain", "brain-stable.current");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  args: string[],
  opts: { cwd: string; cacheDir: string; base: string; repoRoot: string },
): Promise<RunResult> {
  return new Promise((res) => {
    const child = spawn(process.execPath, [BOOTSTRAP, ...args], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        RED_BRAIN_CACHE_DIR: opts.cacheDir,
        RED_BRAIN_RELEASE_BASE: opts.base,
        RED_BRAIN_REPO_ROOT: opts.repoRoot,
        RED_NPM_REGISTRY_BASE: opts.base,
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        NODE_ENV: "test",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => res({ code, stdout, stderr }));
  });
}

describe("brain launcher distribution (ADR 0084, #1032)", () => {
  test("cache hit: a warm cache runs the real cached runtime with zero network", async () => {
    const cacheDir = await makeCacheDir();
    await warmCache(cacheDir);
    const cwd = await enabledCwd();
    const repoRoot = await emptyRepoRoot();
    const release = await startRelease();
    try {
      const r = await run(["hook", "PostToolUse", "--runner", "claude"], {
        cwd,
        cacheDir,
        base: release.url,
        repoRoot,
      });
      expect(r.code).toBe(0);
      // Proves an installed-copy hook executes REAL runtime from the cache —
      // the end of the silent no-op class.
      expect(r.stdout).toContain("BRAIN-RUNTIME-RAN");
      expect(release.hits()).toBe(0);
    } finally {
      await release.close();
    }
  });

  test("cache miss + fetch: SessionStart resolves the runtime and delegates", async () => {
    const cacheDir = await makeCacheDir();
    const cwd = await enabledCwd();
    const repoRoot = await emptyRepoRoot();
    const release = await startRelease();
    try {
      const r = await run(["hook", "SessionStart", "--runner", "claude"], {
        cwd,
        cacheDir,
        base: release.url,
        repoRoot,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("BRAIN-RUNTIME-RAN");
      expect(release.hits()).toBeGreaterThan(0);
      expect(existsSync(cliPath(cacheDir))).toBe(true);
    } finally {
      await release.close();
    }
  });

  test("self-update: a newer same-major registry version swaps the pointer for next boot", async () => {
    const cacheDir = await makeCacheDir();
    await warmCache(cacheDir);
    const cwd = await enabledCwd();
    const repoRoot = await emptyRepoRoot();
    const [major, minor, patch] = VERSION.split(".").map(Number);
    const updated = `${major}.${minor}.${patch + 1}`;
    const release = await startRelease({ version: updated, versions: [VERSION, updated] });
    try {
      const r = await run(["__self-update"], { cwd, cacheDir, base: release.url, repoRoot });
      expect(r.code).toBe(0);
      const pointer = JSON.parse(await readFile(pointerPath(cacheDir), "utf8"));
      expect(pointer.version).toBe(updated);
    } finally {
      await release.close();
    }
  });

  test("self-update: only an out-of-range (new major) registry version leaves the pointer unset", async () => {
    const cacheDir = await makeCacheDir();
    await warmCache(cacheDir);
    const cwd = await enabledCwd();
    const repoRoot = await emptyRepoRoot();
    const [major] = VERSION.split(".").map(Number);
    const nextMajor = `${major + 1}.0.0`;
    const release = await startRelease({ versions: [VERSION, nextMajor] });
    try {
      const r = await run(["__self-update"], { cwd, cacheDir, base: release.url, repoRoot });
      expect(r.code).toBe(0);
      expect(existsSync(pointerPath(cacheDir))).toBe(false);
    } finally {
      await release.close();
    }
  });

  test("gate-inert: a directory that never opted in makes zero network", async () => {
    const cacheDir = await makeCacheDir();
    const cwd = await disabledCwd();
    const repoRoot = await emptyRepoRoot();
    const release = await startRelease();
    try {
      const r = await run(["hook", "PostToolUse", "--runner", "claude"], {
        cwd,
        cacheDir,
        base: release.url,
        repoRoot,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("{}");
      expect(release.hits()).toBe(0);
    } finally {
      await release.close();
    }
  });

  test("offline degrade: a failed first fetch no-ops and leaves a machine-readable marker", async () => {
    const cacheDir = await makeCacheDir();
    const cwd = await enabledCwd();
    const repoRoot = await emptyRepoRoot();
    const release = await startFailingRelease();
    try {
      const r = await run(["hook", "SessionStart", "--runner", "claude"], {
        cwd,
        cacheDir,
        base: release.url,
        repoRoot,
      });
      // Never a crash: the hook no-op contract is preserved.
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("{}");
      // A marker the doctor can later report.
      expect(existsSync(markerPath(cacheDir))).toBe(true);
      const marker = JSON.parse(await readFile(markerPath(cacheDir), "utf8"));
      expect(marker.schema).toBe("red.brain.runtime-degraded.v1");
      expect(marker.plugin).toBe("brain");
      expect(marker.version).toBe(VERSION);
      expect(typeof marker.reason).toBe("string");
      expect(marker.reason.length).toBeGreaterThan(0);
      expect(typeof marker.at).toBe("string");
    } finally {
      await release.close();
    }
  });

  test("ordering: a render/hot-path hook never fetches on a cold cache", async () => {
    const cacheDir = await makeCacheDir();
    const cwd = await enabledCwd();
    const repoRoot = await emptyRepoRoot();
    const release = await startRelease();
    try {
      // PostToolUse fires on every edit — a hot path. On a cold cache it must
      // no-op and defer to SessionStart, never block on a synchronous fetch
      // (the statusline-blanking lesson).
      const r = await run(["hook", "PostToolUse", "--runner", "claude"], {
        cwd,
        cacheDir,
        base: release.url,
        repoRoot,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("{}");
      expect(release.hits()).toBe(0);
      expect(existsSync(cliPath(cacheDir))).toBe(false);
    } finally {
      await release.close();
    }
  });
});
