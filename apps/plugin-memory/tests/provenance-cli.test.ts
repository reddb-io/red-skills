import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readConfig, resolveStoreUri } from "../src/config.js";
import { MemoryStore } from "../src/graph-store.js";
import { slugify } from "../src/store.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[], input?: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    input,
    timeout: TIMEOUT,
  });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-provenance-cli-"));
  roots.push(root);
  return root;
}

describe("memory provenance CLI", () => {
  test(
    "prints stable human-readable provenance for a manually stored graph node",
    async () => {
      const root = await tempRoot();
      expect(runMemory(["init", "--mode", "graph", "--root", root, "--yes"]).status).toBe(0);
      const store = runMemory([
        "store",
        "the provenance audit records manual Memory writes",
        "--root",
        root,
        "--scope",
        "branch",
        "--scope-id",
        "feature/provenance",
      ]);
      expect(store.status, store.stderr).toBe(0);
      const rid = store.stdout.match(/stored node (\d+)/)?.[1];
      expect(rid).toBeDefined();

      const result = runMemory(["provenance", rid ?? "", "--root", root]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`memory provenance: node ${rid}`);
      expect(result.stdout).toContain("source kind: manual");
      expect(result.stdout).toContain("writer: cli");
      expect(result.stdout).toContain("command: memory store");
      expect(result.stdout).toContain("scope: branch feature/provenance");
      expect(result.stdout).toContain("confidence: EXTRACTED");
      expect(result.stdout).toMatch(/created: \d{4}-\d{2}-\d{2}T/);
    },
    TIMEOUT,
  );

  test(
    "prints JSON provenance for a hook-written graph node",
    async () => {
      const root = await tempRoot();
      expect(runMemory(["init", "--mode", "graph", "--hooks", "--root", root, "--yes"]).status).toBe(0);
      const transcript = join(root, "transcript.txt");
      const sentence =
        "We decided to preserve hook provenance because audits need writer metadata.";
      await writeFile(
        transcript,
        sentence,
        "utf8",
      );
      const hook = runMemory(
        [
          "hook",
          "Stop",
          "--runner",
          "codex",
          "--root",
          root,
        ],
        JSON.stringify({
          cwd: root,
          transcript_path: transcript,
        }),
      );
      expect(hook.status, hook.stderr).toBe(0);

      const result = runMemory([
        "provenance",
        slugify(sentence),
        "--root",
        root,
        "--json",
      ]);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        provenance: {
          missing: boolean;
          sourceKind: string;
          writer: string;
          hook: string;
          command: string | null;
          scope: { level: string; id: string | null };
          confidence: string;
          timestamps: { createdAt: string; updatedAt: string };
          evidence: string[];
        };
      };
      expect(body.provenance).toMatchObject({
        missing: false,
        sourceKind: "hook",
        writer: "codex",
        hook: "Stop",
        command: null,
        scope: { level: "project" },
        confidence: "EXTRACTED",
      });
      expect(body.provenance.timestamps.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(body.provenance.timestamps.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(body.provenance.evidence).toContain("transcriptText");
    },
    TIMEOUT,
  );

  test(
    "prints JSON provenance for graph evidence derived from source refresh",
    async () => {
      const root = await tempRoot();
      expect(runMemory(["init", "--mode", "graph", "--root", root, "--yes"]).status).toBe(0);
      const file = join(root, "src", "audit.ts");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "export function auditSource() { return true; }\n", "utf8");
      const refresh = runMemory(["refresh", file, "--root", root, "--json"]);
      expect(refresh.status, refresh.stderr).toBe(0);

      const result = runMemory([
        "provenance",
        `sym:${file}#auditSource`,
        "--root",
        root,
        "--json",
      ]);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        provenance: {
          missing: boolean;
          sourceKind: string;
          writer: string;
          command: string | null;
          hook: string | null;
          confidence: string;
          evidence: string[];
        };
      };
      expect(body.provenance).toMatchObject({
        missing: false,
        sourceKind: "derived",
        writer: "extract-code",
        command: null,
        hook: null,
        confidence: "EXTRACTED",
      });
      expect(body.provenance.evidence).toContain(`${file}:1`);
    },
    TIMEOUT,
  );

  test(
    "reports missing provenance explicitly for legacy graph nodes",
    async () => {
      const root = await tempRoot();
      expect(runMemory(["init", "--mode", "graph", "--root", root, "--yes"]).status).toBe(0);
      const config = await readConfig(root);
      if (!config) throw new Error("config missing after init");
      const store = await MemoryStore.open({ uri: resolveStoreUri(root, config) });
      let rid = 0;
      try {
        rid = await store.upsertNode({
          label: "legacy-with-source-only",
          node_type: "concept",
          properties: {
            title: "legacy with source only",
            source: "manual",
            confidence: "EXTRACTED",
          },
        });
      } finally {
        await store.close();
      }

      const result = runMemory(["provenance", String(rid), "--root", root]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("provenance: missing (node has no provenance metadata)");
      expect(result.stdout).toContain("source kind: missing");
      expect(result.stdout).toContain("confidence: EXTRACTED");
    },
    TIMEOUT,
  );
});
