import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { initGraph } from "../src/init.js";
import { installGitHooks } from "../src/vcs-hooks-install.js";

const TIMEOUT = 90_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const roots: string[] = [];
let launcher = "";

/**
 * A wrapper the installed git hooks invoke through `$RED_MEMORY_CLI`. It cds to
 * the plugin root (so the `tsx` loader resolves) then runs the source CLI,
 * forwarding the hook's `vcs refresh …` args. This is the test stand-in for the
 * bundled runtime the real installer embeds.
 */
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-hooks-launcher-"));
  roots.push(dir);
  launcher = join(dir, "memory-cli.sh");
  await writeFile(
    launcher,
    `#!/bin/sh\ncd ${JSON.stringify(PLUGIN_ROOT)} || exit 1\nexec node --import tsx ${JSON.stringify(
      join(PLUGIN_ROOT, "src/cli.ts"),
    )} "$@"\n`,
    "utf8",
  );
  await chmod(launcher, 0o755);
});

afterEach(async () => {
  await Promise.all(roots.splice(1).map((d) => rm(d, { recursive: true, force: true })));
});

function git(repo: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: TIMEOUT,
    env: { ...process.env, ...extraEnv },
  });
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "memory-hooks-repo-"));
  roots.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.io"]);
  git(repo, ["config", "user.name", "t"]);
  return repo;
}

const HOOK_ENV = () => ({ RED_MEMORY_CLI: `sh ${launcher}` });

describe("git auto-update hooks end-to-end (#236)", () => {
  test(
    "a commit triggers an incremental re-ingest + export (AC1, AC3)",
    async () => {
      const repo = await makeRepo();
      await initGraph(repo);
      await installGitHooks({ hooksDir: join(repo, ".git/hooks") });

      await mkdir(join(repo, "src"), { recursive: true });
      await writeFile(
        join(repo, "src/widget.ts"),
        "export function renderWidget() { return 42; }\n",
        "utf8",
      );
      git(repo, ["add", "src/widget.ts"]);
      const commit = git(repo, ["commit", "-q", "-m", "add widget"], HOOK_ENV());
      expect(commit.status).toBe(0);

      // The post-commit hook ran refresh + export: the bundle exists and the
      // committed symbol made it into the graph.
      const graphJson = join(repo, ".red/memory/export/graph.json");
      expect(existsSync(graphJson)).toBe(true);
      const body = await readFile(graphJson, "utf8");
      expect(body).toContain("renderWidget");
    },
    TIMEOUT,
  );

  test(
    "a branch checkout triggers an incremental refresh (AC2)",
    async () => {
      const repo = await makeRepo();
      await initGraph(repo);
      await installGitHooks({ hooksDir: join(repo, ".git/hooks") });

      await mkdir(join(repo, "src"), { recursive: true });
      await writeFile(join(repo, "src/base.ts"), "export const base = 1;\n", "utf8");
      git(repo, ["add", "src/base.ts"]);
      git(repo, ["commit", "-q", "-m", "base"], HOOK_ENV());

      // Branch carrying a new file.
      git(repo, ["checkout", "-q", "-b", "feature"], HOOK_ENV());
      await writeFile(
        join(repo, "src/feature.ts"),
        "export function featureFlag() { return true; }\n",
        "utf8",
      );
      git(repo, ["add", "src/feature.ts"]);
      git(repo, ["commit", "-q", "-m", "feature"], HOOK_ENV());

      // Drop the export bundle, then switch branches: only the post-checkout
      // hook can recreate it.
      await rm(join(repo, ".red/memory/export"), { recursive: true, force: true });
      const checkout = git(repo, ["checkout", "-q", "main"], HOOK_ENV());
      expect(checkout.status).toBe(0);

      const graphJson = join(repo, ".red/memory/export/graph.json");
      expect(existsSync(graphJson)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "the hook safely no-ops when memory is not initialized (AC5)",
    async () => {
      const repo = await makeRepo();
      // No `memory init` — but install the hooks anyway.
      await installGitHooks({ hooksDir: join(repo, ".git/hooks") });

      await writeFile(join(repo, "README.md"), "# hi\n", "utf8");
      git(repo, ["add", "README.md"]);
      const commit = git(repo, ["commit", "-q", "-m", "docs"], HOOK_ENV());
      expect(commit.status).toBe(0);

      // The config.json guard short-circuits before any CLI runs — no export.
      expect(existsSync(join(repo, ".red/memory/export"))).toBe(false);
    },
    TIMEOUT,
  );
});
