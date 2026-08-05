// #2736 — the resident auto-spawn must target the rsp entry, never the caller's
// own argv[1]. A dev-bundle or castle-mcp host that re-execs itself with
// `warm-resident` loses elision in silence, because rsp fails open by contract.
import { spawnSync } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ensureResidentServer,
  resolveResidentPaths,
  resolveRspEntry,
  RSP_ENTRY_UNRESOLVED,
} from "../src/resident-client.js";
import { hookDecisionFromClaudePreExecJson, formatHookDecision } from "../src/intercept.js";
import { cli, commitMany, enableRsp, initGitRepo, installRspShim, tempRoot, tsxLoader } from "./cli.helpers.js";

/** Every ambient escape hatch cleared, so a lookup only sees what the test plants. */
function bareEnv(cacheRoot: string): NodeJS.ProcessEnv {
  return { RED_SKILLS_CACHE_DIR: cacheRoot };
}

/** Run `body` with the ambient rsp-entry env vars removed from this process. */
async function withoutAmbientEntry<T>(cacheRoot: string, body: () => Promise<T>): Promise<T> {
  const names = [
    "RSP_BIN",
    "RED_SKILLS_CACHE_DIR",
    "RED_SKILLS_DEV_PLUGIN_ROOT",
    "CLAUDE_PLUGIN_ROOT",
    "CODEX_PLUGIN_ROOT",
    "OPENCODE_PLUGIN_ROOT",
  ];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.RED_SKILLS_CACHE_DIR = cacheRoot;
  try {
    return await body();
  } finally {
    for (const [name, value] of saved) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("resident spawn target (#2736)", () => {
  it("targets the rsp bundle when the caller's argv[1] is a foreign bundle", async () => {
    const root = await tempRoot();
    const dist = join(root, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "rsp.bundle.min.mjs"), "// rsp\n");
    // The dev plugin bundle: a host that does not route `warm-resident`.
    const callerEntry = join(dist, "dev.bundle.min.mjs");
    await writeFile(callerEntry, "// dev\n");

    const entry = resolveRspEntry({}, {
      rootDir: root,
      callerEntry,
      env: bareEnv(join(root, "cache")),
    });

    expect(entry).toMatchObject({ command: process.execPath, source: "caller-sibling-bundle" });
    expect("args" in entry && entry.args.at(-1)).toBe(join(dist, "rsp.bundle.min.mjs"));
  });

  it("targets the cache-keyed rsp bundle beside a cache-keyed host bundle", async () => {
    const root = await tempRoot();
    const cache = join(root, "cache");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "rsp-2.87.5.bundle.min.mjs"), "// rsp\n");
    const callerEntry = join(cache, "dev-2.87.5.bundle.min.mjs");
    await writeFile(callerEntry, "// dev\n");

    const entry = resolveRspEntry({}, { callerEntry, env: bareEnv(join(root, "empty")) });

    expect("args" in entry && entry.args.at(-1)).toBe(join(cache, "rsp-2.87.5.bundle.min.mjs"));
  });

  it("targets the plugin-root rsp bundle when a castle-mcp-shaped host asks", async () => {
    const root = await tempRoot();
    const pluginRoot = join(root, "plugins", "dev");
    await mkdir(join(pluginRoot, "dist"), { recursive: true });
    await writeFile(join(pluginRoot, "dist", "rsp.bundle.min.mjs"), "// rsp\n");

    const entry = resolveRspEntry({}, {
      callerEntry: join(root, "somewhere", "castle-mcp.bundle.min.mjs"),
      env: { ...bareEnv(join(root, "empty")), CLAUDE_PLUGIN_ROOT: pluginRoot },
    });

    expect(entry).toMatchObject({ source: "plugin-root-bundle" });
    expect("args" in entry && entry.args.at(-1)).toBe(join(pluginRoot, "dist", "rsp.bundle.min.mjs"));
  });

  it("re-execs the caller when the caller IS the rsp entry", async () => {
    const root = await tempRoot();
    const callerEntry = join(root, "apps", "rsp", "src", "cli.ts");

    const entry = resolveRspEntry({}, { callerEntry, env: bareEnv(join(root, "empty")) });

    expect(entry).toMatchObject({ source: "caller-entry" });
    expect("args" in entry && entry.args.at(-1)).toBe(callerEntry);
  });

  it("lets an explicit serverCommand win over the resolver", async () => {
    const root = await tempRoot();
    const dist = join(root, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "rsp.bundle.min.mjs"), "// rsp\n");

    const entry = resolveRspEntry(
      { serverCommand: "/opt/custom/rsp", serverArgs: ["--flag"] },
      { rootDir: root, callerEntry: join(dist, "dev.bundle.min.mjs"), env: bareEnv(join(root, "cache")) },
    );

    expect(entry).toEqual({ command: "/opt/custom/rsp", args: ["--flag"], source: "server-command" });
  });

  it("names the diagnostic when no rsp entry exists instead of spawning a host that ignores warm-resident", async () => {
    const root = await tempRoot();
    const callerEntry = join(root, "dist", "dev.bundle.min.mjs");

    const entry = resolveRspEntry({}, { rootDir: root, callerEntry, env: bareEnv(join(root, "empty")) });

    expect(entry).toMatchObject({ diagnostic: RSP_ENTRY_UNRESOLVED, callerEntry });
    expect("searched" in entry && entry.searched.length).toBeGreaterThan(0);
    // The foreign host is never proposed as the spawn target.
    expect("searched" in entry && entry.searched).not.toContain(callerEntry);
  });

  it("rejects an auto-spawn with the named diagnostic rather than starting the wrong process", async () => {
    const root = await tempRoot();
    const paths = resolveResidentPaths(root);

    await withoutAmbientEntry(join(root, "empty-cache"), async () => {
      await expect(ensureResidentServer(paths, {
        storeUri: `file://${join(root, ".red", "tmp", "red-skills.rdb")}`,
        ttlDays: 7,
        byteBudget: 1024,
      })).rejects.toThrow(new RegExp(RSP_ENTRY_UNRESOLVED));
    });
  });

  it("says the diagnostic out loud on the hook path and still rewrites the command", async () => {
    const root = await tempRoot();
    await enableRsp(root);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const decision = await hookDecisionFromClaudePreExecJson(
        JSON.stringify({ cwd: root, tool_input: { command: "git status" } }),
        {
          cwd: root,
          isEnabled: () => true,
          resolveBinary: () => true,
          wakeResident: () => {
            throw Object.assign(new Error("no rsp entry"), { code: RSP_ENTRY_UNRESOLVED });
          },
          resolveBinary: () => true,
          rspInvocationPrefix: ["rsp"],
        },
      );

      expect(decision.kind).toBe("rewrite");
      expect(formatHookDecision(decision).status).toBe(0);
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(RSP_ENTRY_UNRESOLVED);
    } finally {
      stderr.mockRestore();
    }
  });

  it("names the diagnostic on a foreign host and keeps the wrapped command's stdout, stderr and status", async () => {
    const root = await initGitRepo();
    expect(spawnSync(process.execPath, ["--import", tsxLoader, cli, "setup"], {
      cwd: root,
      encoding: "utf8",
    }).status).toBe(0);
    await commitMany(root, 1);
    const rspPath = await installRspShim(root);

    // A host that is not the rsp CLI: its own argv[1] never routes `warm-resident`.
    const host = join(root, "foreign-host.mjs");
    await writeFile(
      host,
      `import { main } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "src", "cli", "main.ts")).href)};\n` +
        "process.exit(await main(process.argv.slice(2)));\n",
    );
    const emptyCache = join(root, "empty-cache");
    await mkdir(emptyCache, { recursive: true });
    const binDir = join(root, "bin");
    const rsp = join(binDir, "rsp");
    await mkdir(binDir, { recursive: true });
    await writeFile(rsp, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(rsp, 0o755);

<<<<<<< HEAD
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: rspPath, RED_SKILLS_CACHE_DIR: emptyCache };
||||||| 6464c9aea
    const env: NodeJS.ProcessEnv = { ...process.env, RED_SKILLS_CACHE_DIR: emptyCache };
=======
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      RED_SKILLS_CACHE_DIR: emptyCache,
    };
>>>>>>> origin/main
    for (const name of [
      "RSP_BIN",
      "RSP_DEBUG",
      "RED_SKILLS_DEV_PLUGIN_ROOT",
      "CLAUDE_PLUGIN_ROOT",
      "CODEX_PLUGIN_ROOT",
      "OPENCODE_PLUGIN_ROOT",
    ]) delete env[name];
    const onHost = (args: string[], input?: string) =>
      spawnSync(process.execPath, ["--import", tsxLoader, host, ...args], {
        cwd: root,
        env,
        encoding: "utf8",
        ...(input ? { input } : {}),
      });

    // The hook awaits its wake, so the failure says its name instead of losing
    // elision in silence — and it still allows the command through.
    const hook = onHost(
      ["hook", "claude-pre-exec"],
      JSON.stringify({ cwd: root, tool_input: { command: "git status" } }),
    );
    expect(hook.stderr).toContain(RSP_ENTRY_UNRESOLVED);
    expect(hook.status).toBe(0);
    expect(hook.stdout).toContain("updatedInput");

    // Fail-open holds after the diagnostic: the wrapped command still ran …
    const log = onHost(["git", "log"]);
    expect(log.status).toBe(0);
    expect(log.stdout).toContain("commit 1");

    // … and a failing command keeps its own raw stderr and non-zero exit.
    const failed = onHost(["git", "diff", "bogus-ref"]);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("fatal: ambiguous argument 'bogus-ref'");

    await rm(host, { force: true });
  }, 60_000);
});
