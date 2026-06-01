import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { parseAuditMarker } from "../src/audit-marker.js";
import { initGraph } from "../src/init.js";
import { MEMORY_IGNORE_FILENAME } from "../src/scope.js";

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-ingest-cli-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT });
}

function runMemory(cwd: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", join(PLUGIN_ROOT, "src/cli.ts"), ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("memory ingest CLI — audit-marker guidance", () => {
  test(
    "emits a contract-valid Memory-Ingested trailer for HEAD after a successful ingest",
    async () => {
      const root = await tempRoot();
      await initGraph(root);

      // A real git repo so the guidance resolves a concrete HEAD SHA.
      git(root, "init", "-q");
      git(root, "config", "user.email", "afk@example.com");
      git(root, "config", "user.name", "AFK");
      const file = join(root, "src/widget.ts");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "export const widget = () => 42;\n", "utf8");
      git(root, "add", "src/widget.ts");
      git(root, "commit", "-q", "-m", "seed");
      const head = git(root, "rev-parse", "--verify", "HEAD").stdout.trim();

      const result = runMemory(root, ["ingest", root, "--root", root]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("memory: ingested");

      const trailerLine = result.stdout
        .split("\n")
        .find((l) => l.includes("Memory-Ingested:"))
        ?.trim();
      expect(trailerLine).toBeDefined();
      expect(parseAuditMarker(trailerLine!)).toEqual({
        form: "commit-trailer",
        kind: "ingested",
        sha: head,
      });
      // The bypass form is advertised too.
      expect(result.stdout).toContain("Memory-NoIngest:");
    },
    TIMEOUT,
  );

  test(
    "falls back to the <ingest-sha> placeholder outside a git repo",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      await writeFile(join(root, "note.md"), "# note\n", "utf8");

      const result = runMemory(root, ["ingest", root, "--root", root]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Memory-Ingested: <ingest-sha>");
    },
    TIMEOUT,
  );
});

describe("memory ingest CLI — scope wizard (#235)", () => {
  async function seedRepo(): Promise<string> {
    const root = await tempRoot();
    await initGraph(root);
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "libs/core"), { recursive: true });
    await writeFile(join(root, "src/app.ts"), "export const app = 1;\n", "utf8");
    await writeFile(join(root, "src/app.test.ts"), "export const t = 1;\n", "utf8");
    await writeFile(join(root, "libs/core/index.ts"), "export const lib = 1;\n", "utf8");
    return root;
  }

  test(
    "reports the candidate-file count before processing (AC1)",
    async () => {
      const root = await seedRepo();
      const result = runMemory(root, ["ingest", root, "--root", root]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/candidate file\(s\)/);
      // The scope report precedes the ingest summary line.
      expect(result.stdout.indexOf("candidate file(s)")).toBeLessThan(
        result.stdout.indexOf("memory: ingested"),
      );
    },
    TIMEOUT,
  );

  test(
    "a scope preset narrows the candidate set (AC2)",
    async () => {
      const root = await seedRepo();
      const proceed = runMemory(root, ["ingest", root, "--root", root, "--scope", "proceed"]);
      const core = runMemory(root, ["ingest", root, "--root", root, "--scope", "core"]);
      expect(proceed.status).toBe(0);
      expect(core.status).toBe(0);
      expect(core.stdout).toContain("memory ingest scope: core only");
      // core drops src/app.test.ts and the libs/ tree → fewer candidates than proceed.
      const count = (out: string) => Number(/(\d+) candidate file\(s\)/.exec(out)?.[1]);
      expect(count(core.stdout)).toBeLessThan(count(proceed.stdout));
    },
    TIMEOUT,
  );

  test(
    "generate-ignore writes a committed, human-editable ignore file and skips ingest (AC3)",
    async () => {
      const root = await seedRepo();
      const result = runMemory(root, [
        "ingest",
        root,
        "--root",
        root,
        "--scope",
        "generate-ignore",
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(MEMORY_IGNORE_FILENAME);
      expect(result.stdout).not.toContain("memory: ingested"); // no ingest this run
      const body = await readFile(join(root, MEMORY_IGNORE_FILENAME), "utf8");
      expect(body).toMatch(/^#/m); // header comment → human-editable
      expect(body).toContain("**/node_modules/**");
    },
    TIMEOUT,
  );

  test(
    "subsequent runs honour the committed ignore file without re-prompting (AC4)",
    async () => {
      const root = await seedRepo();
      // Ignore the whole libs/ tree via a hand-written .memoryignore.
      await writeFile(join(root, MEMORY_IGNORE_FILENAME), "# team scope\n**/libs/**\n", "utf8");
      const result = runMemory(root, ["ingest", root, "--root", root]);
      expect(result.status).toBe(0);
      const count = Number(/(\d+) candidate file\(s\)/.exec(result.stdout)?.[1]);
      // src/app.ts + src/app.test.ts remain; libs/core/index.ts is ignored.
      expect(count).toBe(2);
    },
    TIMEOUT,
  );
});
