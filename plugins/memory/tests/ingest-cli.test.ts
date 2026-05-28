import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { parseAuditMarker } from "../src/audit-marker.js";
import { initGraph } from "../src/init.js";

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
