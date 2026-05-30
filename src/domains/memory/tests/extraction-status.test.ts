import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readConfig, writeConfig } from "../src/config.js";
import { buildMemoryExtractionStatus } from "../src/extraction-status.js";
import { buildMemoryExtractionStatusViewerArtifact } from "../src/extraction-status-viewer.js";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";

const roots: string[] = [];
const stores: MemoryStore[] = [];
const pkgRoot = resolve(__dirname, "..");
const TIMEOUT = 40_000;

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function graphRoot(opts: { hooks?: boolean } = {}): Promise<{
  root: string;
  store: MemoryStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "memory-extraction-status-"));
  roots.push(root);
  const { storeUri } = await initGraph(root, { hooks: opts.hooks });
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);
  return { root, store };
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory extraction status", () => {
  test("reports deterministic extraction and missing inferred provider config", async () => {
    const { root, store } = await graphRoot();

    const status = await buildMemoryExtractionStatus(store, root, {
      now: 1_700_000_000_000,
    });

    expect(status).toMatchObject({
      schema_version: "memory.extraction_status.v1",
      read_only: true,
      deterministic: {
        markdown_entities: true,
        code_calls: true,
        code_type_uses: true,
        sql_schema_references: true,
        dev_workflow: true,
        structured_transcript: true,
      },
      inferred: {
        configured: false,
        available: false,
        facts: 0,
        hook_stop_enabled: false,
      },
    });
    expect(status.inferred.error).toContain("no AI provider configured");
    expect(status.recommended_next_actions).toContain(
      "use `memory extract --local` for structured transcripts or configure `provider` for free-form inferred extraction",
    );
  });

  test("builds a self-contained extraction status viewer", async () => {
    const { root, store } = await graphRoot();
    const status = await buildMemoryExtractionStatus(store, root, {
      now: 1_700_000_000_000,
    });

    const artifact = buildMemoryExtractionStatusViewerArtifact(status);

    expect(artifact.contract).toEqual({
      name: "memory.extraction_status.viewer",
      version: "memory.extraction_status.viewer.v1",
      consumes: "memory.extraction_status.v1",
    });
    expect(artifact.status.schema_version).toBe("memory.extraction_status.v1");
    expect(artifact.html).toContain("Extraction Status");
    expect(artifact.html).toContain("markdown entities");
    expect(artifact.html).toContain("Inferred Extraction");
    expect(artifact.html).toContain('id="extraction-status-data"');
    expect(artifact.html).not.toContain("<script src=");
  });

  test(
    "CLI can extract structured transcript facts without a provider",
    async () => {
      const { root, store } = await graphRoot();
      await store.close();
      stores.pop();
      const transcript = join(root, "transcript.txt");
      await writeFile(
        transcript,
        [
          "Problem: cache invalidation failed after deploy.",
          "Fix: rebuild the cache index during startup.",
          "Validation: pnpm test cache passed.",
        ].join("\n"),
        "utf8",
      );

      const result = runMemory(["extract", transcript, "--root", root]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "memory: extracted 3 INFERRED fact(s), 2 edge(s) via local structured transcript",
      );

      const status = runMemory(["extraction", "status", "--root", root, "--json"]);
      expect(status.status, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        inferred: { facts: 3 },
      });
    },
    TIMEOUT,
  );

  test("reports local provider egress and inferred fact count", async () => {
    const { root, store } = await graphRoot({ hooks: true });
    const config = await readConfig(root);
    if (!config) throw new Error("missing test config");
    await writeConfig(root, {
      ...config,
      provider: {
        mode: "openai-compat",
        model: "llama3.1",
        baseUrl: "http://localhost:11434/v1",
      },
    });
    await store.upsertNode({
      label: "decision:use-provider-status",
      node_type: "decision",
      properties: {
        title: "Use provider status",
        content: "Decision: surface inferred extraction readiness.",
        confidence: "INFERRED",
      },
    });

    const status = await buildMemoryExtractionStatus(store, root);

    expect(status.inferred).toMatchObject({
      configured: true,
      available: true,
      mode: "openai-compat",
      model: "llama3.1",
      endpoint: "http://localhost:11434/v1",
      egress: "local",
      hook_stop_enabled: true,
      facts: 1,
    });
    expect(status.recommended_next_actions).toEqual(["Memory extraction paths are ready"]);
  });

  test("reports a bedrock provider's region-derived endpoint and external egress", async () => {
    const { root, store } = await graphRoot({ hooks: true });
    const config = await readConfig(root);
    if (!config) throw new Error("missing test config");
    await writeConfig(root, {
      ...config,
      provider: {
        mode: "bedrock",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        region: "us-east-1",
      },
    });

    const status = await buildMemoryExtractionStatus(store, root);

    expect(status.inferred).toMatchObject({
      configured: true,
      available: true,
      mode: "bedrock",
      model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      endpoint: "https://bedrock-runtime.us-east-1.amazonaws.com",
      egress: "external",
    });
  });

  test("CLI reports extraction status as JSON", async () => {
    const { root, store } = await graphRoot();
    await store.close();
    stores.pop();

    const result = runMemory(["extraction", "status", "--root", root, "--json"]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema_version: "memory.extraction_status.v1",
      deterministic: {
        sql_schema_references: true,
      },
      inferred: {
        configured: false,
        available: false,
      },
    });
  });

  test("CLI writes extraction status viewer HTML", async () => {
    const { root, store } = await graphRoot();
    await store.close();
    stores.pop();
    const out = join(root, "extraction-status.html");

    const result = runMemory(["extraction", "status-viewer", "--root", root, "--out", out]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("memory: extraction status viewer written");
    expect(result.stdout).toContain("contract: memory.extraction_status.v1");
    const html = await readFile(out, "utf8");
    expect(html).toContain("Extraction Status");
    expect(html).toContain('id="extraction-status-data"');
  });
});
