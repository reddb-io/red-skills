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
import { platformKey } from "../../../plugins/memory/scripts/bootstrap.mjs";

// End-to-end launcher behaviour for the Memory runtime (ADR 0084 tracer, #1030).
//
// These tests spawn the real `bootstrap.mjs` — the committed launcher that
// marketplace-installed copies run in place of built output — against a local
// release server, and prove the four distribution guarantees:
//
//   1. cache hit         → a warm cache runs REAL runtime from disk, zero network
//   2. cache miss + fetch → the SessionStart resolve point downloads + delegates
//   3. gate-inert        → a directory that never opted in makes zero network
//   4. offline degrade   → a failed first fetch no-ops and leaves a marker
//   5. ordering          → a render/hot-path hook never fetches on a cold cache
//
// The launcher resolves the plugin version from CLAUDE_PLUGIN_ROOT and every
// asset URL from RED_MEMORY_RELEASE_BASE, so no real network is ever touched.

const BOOTSTRAP = resolve(__dirname, "../../../plugins/memory/scripts/bootstrap.mjs");
const PLUGIN_ROOT = resolve(__dirname, "../../../plugins/memory");
const VERSION: string = JSON.parse(
  readFileSync(resolve(PLUGIN_ROOT, ".claude-plugin/plugin.json"), "utf8"),
).version;
const RED_KEY: string = platformKey(process.platform, process.arch);

// A fake runtime that announces itself so a test can prove the real cached
// runtime — not a no-op — executed.
const CLI_BODY = `#!/usr/bin/env node
process.stdout.write("MEMORY-RUNTIME-RAN " + process.argv.slice(2).join(" ") + "\\n");
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
    schema: "red.memory.runtime.v1",
    version,
    cli: { asset: "memory-cli.mjs", sha256: sha(CLI_BODY) },
    mcp: { asset: "memory-mcp.mjs", sha256: sha(MCP_BODY) },
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
    "memory-runtime-manifest.json": manifest,
    "memory-cli.mjs": CLI_BODY,
    "memory-mcp.mjs": MCP_BODY,
    [`red-${RED_KEY}`]: RED_BODY,
    // The scoped package's registry metadata document (basename of the
    // `%2F`-escaped registry URL the launcher queries for newest same-major).
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
  const d = await mkdtemp(join(tmpdir(), "mem-cache-"));
  scratch.push(d);
  return d;
}

async function enabledCwd(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mem-on-"));
  scratch.push(d);
  await mkdir(join(d, ".red"), { recursive: true });
  await writeFile(join(d, ".red", "config.yaml"), "plugins:\n  memory:\n    enabled: true\n");
  return d;
}

async function disabledCwd(): Promise<string> {
  // A temp dir with no `.red/config.yaml` in any ancestor — the gate (ADR 0067)
  // treats memory as disabled.
  const d = await mkdtemp(join(tmpdir(), "mem-off-"));
  scratch.push(d);
  return d;
}

/** Pre-populate the version-keyed cache with the fake runtime (a warm cache). */
async function warmCache(cacheDir: string): Promise<void> {
  const dir = join(cacheDir, "reddb-memory", VERSION);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "memory-cli.mjs"), CLI_BODY);
  await writeFile(join(dir, "memory-mcp.mjs"), MCP_BODY);
  const red = join(dir, process.platform === "win32" ? "red.exe" : "red");
  await writeFile(red, RED_BODY);
  await chmod(red, 0o755);
}

async function waitForFile(path: string, deadlineMs = 2_000): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch {
      if (Date.now() >= deadline) throw new Error(`file was not written: ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

const cliPath = (cacheDir: string) =>
  join(cacheDir, "reddb-memory", VERSION, "memory-cli.mjs");
const markerPath = (cacheDir: string) =>
  join(cacheDir, "reddb-memory", "runtime-degraded.json");
const pointerPath = (cacheDir: string) =>
  join(cacheDir, "reddb-memory", "memory-stable.current");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  args: string[],
  opts: { cwd: string; cacheDir: string; base: string },
): Promise<RunResult> {
  return new Promise((res) => {
    const child = spawn(process.execPath, [BOOTSTRAP, ...args], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        RED_MEMORY_CACHE_DIR: opts.cacheDir,
        RED_MEMORY_RELEASE_BASE: opts.base,
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

describe("memory launcher distribution (ADR 0084, #1030)", () => {
  test("cache hit: a warm cache runs the real cached runtime with zero network", async () => {
    const cacheDir = await makeCacheDir();
    await warmCache(cacheDir);
    const cwd = await enabledCwd();
    const release = await startRelease();
    try {
      const r = await run(["hook", "PostToolUse", "--runner", "claude"], {
        cwd,
        cacheDir,
        base: release.url,
      });
      expect(r.code).toBe(0);
      // Proves an installed-copy hook executes REAL runtime from the cache —
      // the end of the silent no-op class.
      expect(r.stdout).toContain("MEMORY-RUNTIME-RAN");
      expect(release.hits()).toBe(0);
    } finally {
      await release.close();
    }
  });

  test("cache miss + fetch: SessionStart resolves the runtime and delegates", async () => {
    const cacheDir = await makeCacheDir();
    const cwd = await enabledCwd();
    const release = await startRelease();
    try {
      const r = await run(["hook", "SessionStart", "--runner", "claude"], {
        cwd,
        cacheDir,
        base: release.url,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("MEMORY-RUNTIME-RAN");
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
    const [major, minor, patch] = VERSION.split(".").map(Number);
    const updated = `${major}.${minor}.${patch + 1}`;
    // The registry advertises a newer same-major version; the pinned runtime is
    // served by the same fake release (by basename). No sigstore anywhere.
    const release = await startRelease({ version: updated, versions: [VERSION, updated] });
    try {
      const r = await run(["__self-update"], { cwd, cacheDir, base: release.url });
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
    const [major] = VERSION.split(".").map(Number);
    const nextMajor = `${major + 1}.0.0`;
    const release = await startRelease({ versions: [VERSION, nextMajor] });
    try {
      const r = await run(["__self-update"], { cwd, cacheDir, base: release.url });
      expect(r.code).toBe(0);
      expect(existsSync(pointerPath(cacheDir))).toBe(false);
    } finally {
      await release.close();
    }
  });

  test("gate-inert: a directory that never opted in makes zero network", async () => {
    const cacheDir = await makeCacheDir();
    const cwd = await disabledCwd();
    const release = await startRelease();
    try {
      const r = await run(["hook", "PostToolUse", "--runner", "claude"], {
        cwd,
        cacheDir,
        base: release.url,
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
    const release = await startFailingRelease();
    try {
      const r = await run(["hook", "SessionStart", "--runner", "claude"], {
        cwd,
        cacheDir,
        base: release.url,
      });
      // Never a crash: the hook no-op contract is preserved.
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("{}");
      // A marker the doctor can later report.
      expect(existsSync(markerPath(cacheDir))).toBe(true);
      const marker = JSON.parse(await readFile(markerPath(cacheDir), "utf8"));
      expect(marker.schema).toBe("red.memory.runtime-degraded.v1");
      expect(marker.plugin).toBe("memory");
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
    const release = await startRelease();
    try {
      // PostToolUse fires on every edit — a hot path. On a cold cache it must
      // no-op and defer to SessionStart, never block on a synchronous fetch
      // (the statusline-blanking lesson).
      const r = await run(["hook", "PostToolUse", "--runner", "claude"], {
        cwd,
        cacheDir,
        base: release.url,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("{}");
      expect(release.hits()).toBe(0);
      expect(existsSync(cliPath(cacheDir))).toBe(false);
    } finally {
      await release.close();
    }
  });

  test("SessionStart triggers plugin-owned TOON migration through detached dev command", async () => {
    const cacheDir = await makeCacheDir();
    await warmCache(cacheDir);
    const cwd = await enabledCwd();
    await mkdir(join(cwd, ".red", "memory"), { recursive: true });
    await writeFile(join(cwd, ".red", "memory", "config.json"), JSON.stringify({ mode: "graph" }), "utf8");
    const probe = join(cwd, ".red", "tmp", "migration-probe.txt");
    const fakeDev = join(cwd, ".red", "tmp", "fake-dev-entrypoint.mjs");
    await mkdir(join(cwd, ".red", "tmp"), { recursive: true });
    await writeFile(
      fakeDev,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(probe)}, process.argv.slice(2).join(" ") + "\\n");
`,
      "utf8",
    );
    const release = await startRelease();
    try {
      const child = spawn(process.execPath, [BOOTSTRAP, "hook", "SessionStart", "--runner", "claude"], {
        cwd,
        env: {
          ...process.env,
          RED_MEMORY_CACHE_DIR: cacheDir,
          RED_MEMORY_RELEASE_BASE: release.url,
          RED_NPM_REGISTRY_BASE: release.url,
          RED_DEV_ENTRYPOINT: fakeDev,
          CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
          NODE_ENV: "test",
        },
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => (stdout += d));
      const code = await new Promise<number | null>((res) => child.on("close", res));

      expect(code).toBe(0);
      expect(stdout).toBe("MEMORY-RUNTIME-RAN hook SessionStart --runner claude\n");
      const observed = await waitForFile(probe);
      expect(observed).toContain("toon-migrate --plugin memory");
      expect(observed).toContain("--triggered-by bootstrap");
    } finally {
      await release.close();
    }
  });
});
