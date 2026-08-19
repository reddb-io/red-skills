import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { graphRecall } from "../src/graph-recall.js";
import { MemoryStore } from "../src/graph-store.js";
import { ingestProject, refreshFiles, renderIngestReportToon } from "../src/ingest.js";

// RedDB connects by spawning the bundled `red` binary; give each test room.
const TIMEOUT = 30_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = join(HERE, "fixtures/repo");
const IMPORT_FIXTURE_REPO = join(HERE, "fixtures/imports");
const RUST_IMPORT_FIXTURE_REPO = join(HERE, "fixtures/rust-imports");
const GO_IMPORT_FIXTURE_REPO = join(HERE, "fixtures/go-imports");
const PYTHON_IMPORT_FIXTURE_REPO = join(HERE, "fixtures/python-imports");
const SQL_SCHEMA_FIXTURE_REPO = join(HERE, "fixtures/sql-schema");
const DEV_ARTIFACT_FIXTURE_REPO = join(HERE, "fixtures/dev-artifacts");

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function openStore(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "memory-ingest-"));
  roots.push(dir);
  const store = await MemoryStore.open({
    uri: `file://${join(dir, "graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("ingestProject over a TS+MD fixture repo", () => {
  test(
    "indexes code symbols and markdown concepts into the graph",
    async () => {
      const store = await openStore();
      const report = await ingestProject(store, { cwd: FIXTURE_REPO });

      // 1 TS file + 1 MD file.
      expect(report.files).toBe(2);
      expect(report.docs).toBe(1);
      // file + 5 symbols, root concept + 3 heading concepts + referenced entities.
      expect(report.nodes).toBeGreaterThanOrEqual(6 + 7);
      expect(report.edges).toBeGreaterThanOrEqual(3);

      const { nodes } = await store.stats();
      expect(nodes).toBe(report.nodes);
    },
    TIMEOUT,
  );

  test(
    "semantic pass writes INFERRED graph facts with confidence bands and token cost",
    async () => {
      const store = await openStore();
      const calls: string[] = [];
      const report = await ingestProject(store, {
        cwd: FIXTURE_REPO,
        semantic: {
          enabled: true,
          client: {
            async complete(req) {
              calls.push(`${req.system}\n${req.user}`);
              return JSON.stringify({
                facts: [
                  {
                    label: "fixture-token-rotation",
                    node_type: "decision",
                    title: "Fixture token rotation",
                    summary: "The fixture documents JWT token rotation behavior.",
                    confidence_band: "high",
                    relations: [{ label: "REFERENCES", target: "fixture-token-verifier" }],
                  },
                  {
                    label: "fixture-token-verifier",
                    node_type: "symbol",
                    title: "Fixture token verifier",
                    summary: "The code fixture verifies issued tokens.",
                    confidence_band: "medium",
                  },
                ],
              });
            },
          },
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("src/auth.ts");
      expect(calls[0]).toContain("docs/guide.md");
      expect(report.semantic).toMatchObject({
        enabled: true,
        nodes: 2,
        edges: 1,
      });
      expect(report.semantic.token_cost.input).toBeGreaterThan(0);
      expect(report.semantic.token_cost.output).toBeGreaterThan(0);

      const nodes = await store.listNodes();
      const inferred = nodes.find((node) => node.label === "fixture-token-rotation");
      expect(inferred).toMatchObject({
        node_type: "decision",
        properties: {
          confidence: "INFERRED",
          confidence_band: "high",
          source: "corpus-ingest",
        },
      });
      const target = nodes.find((node) => node.label === "fixture-token-verifier");
      expect(target?.properties.confidence_band).toBe("medium");
      const edges = await store.listEdges();
      const inferredEdge = edges.find(
        (edge) =>
          edge.from_rid === inferred?.rid &&
          edge.to_rid === target?.rid &&
          edge.label === "REFERENCES",
      );
      expect(inferredEdge?.properties ?? inferredEdge?.PROPERTIES).toEqual(
        expect.objectContaining({
          confidence: "INFERRED",
          confidence_band: "medium",
        }),
      );

      const toon = renderIngestReportToon(report, { includeSemanticCost: true });
      expect(toon).toContain("ingest[1]{files,nodes,edges,docs");
      expect(toon).toContain("semantic_token_input");
      expect(toon).toContain("semantic_token_output");
    },
    TIMEOUT,
  );

  test(
    "structural-only semantic setting skips provider entirely and omits cost from TOON",
    async () => {
      const store = await openStore();
      let calls = 0;
      const report = await ingestProject(store, {
        cwd: FIXTURE_REPO,
        semantic: {
          enabled: false,
          client: {
            async complete() {
              calls += 1;
              throw new Error("provider must not be called");
            },
          },
        },
      });

      expect(calls).toBe(0);
      expect(report.semantic).toEqual({
        enabled: false,
        nodes: 0,
        edges: 0,
        token_cost: { input: 0, output: 0 },
      });
      expect(renderIngestReportToon(report, { includeSemanticCost: false })).not.toContain(
        "semantic_token",
      );
    },
    TIMEOUT,
  );

  test(
    "recall finds an ingested code symbol",
    async () => {
      const store = await openStore();
      await ingestProject(store, { cwd: FIXTURE_REPO });

      const hits = await graphRecall(store, "issueToken");
      const titles = hits.map((h) => h.label);
      expect(titles.some((l) => l.includes("issueToken"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "ingests conservative intra-file CALLS and USES_TYPE edges for code symbols",
    async () => {
      const store = await openStore();
      await ingestProject(store, { cwd: FIXTURE_REPO });

      const nodes = await store.listNodes();
      const edges = await store.listEdges();
      const issueToken = nodes.find((n) => n.label.endsWith("#issueToken"));
      const verifyToken = nodes.find((n) => n.label.endsWith("#verifyToken"));
      const userId = nodes.find((n) => n.label.endsWith("#UserId"));

      expect(issueToken).toBeDefined();
      expect(verifyToken).toBeDefined();
      expect(userId).toBeDefined();
      const callEdge = edges.find(
        (edge) =>
          edge.from_rid === issueToken?.rid &&
          edge.to_rid === verifyToken?.rid &&
          edge.label === "CALLS",
      );
      expect(callEdge).toBeDefined();
      expect(Number(callEdge?.weight ?? callEdge?.WEIGHT)).toBeGreaterThan(0);
      expect(callEdge?.properties ?? callEdge?.PROPERTIES).toEqual(
        expect.objectContaining({
          confidence: "EXTRACTED",
          extraction_backend: "typescript-compiler",
          topological_weight: expect.any(Number),
          provenance: expect.objectContaining({
            source_kind: "derived",
            writer: "extract-code",
          }),
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          from_rid: issueToken?.rid,
          to_rid: userId?.rid,
          label: "USES_TYPE",
        }),
      );
    },
    TIMEOUT,
  );

  test(
    "recall finds an ingested markdown concept",
    async () => {
      const store = await openStore();
      await ingestProject(store, { cwd: FIXTURE_REPO });

      const hits = await graphRecall(store, "token rotation");
      expect(hits.some((h) => /rotation/i.test(h.label) || /rotation/i.test(h.excerpt))).toBe(
        true,
      );
    },
    TIMEOUT,
  );

  test(
    "recall finds a grounded markdown referenced entity",
    async () => {
      const store = await openStore();
      await ingestProject(store, { cwd: FIXTURE_REPO });

      const hits = await graphRecall(store, "JWT_SECRET");
      expect(hits.some((h) => h.label === "entity:jwt_secret")).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "re-ingesting the same tree is idempotent (dedupe by hash)",
    async () => {
      const store = await openStore();
      const first = await ingestProject(store, { cwd: FIXTURE_REPO });
      const before = await store.stats();
      await ingestProject(store, { cwd: FIXTURE_REPO });
      const after = await store.stats();

      expect(after.nodes).toBe(before.nodes);
      expect(after.nodes).toBe(first.nodes);
    },
    TIMEOUT,
  );

  test(
    "incremental refresh skips unchanged files by content identity and reports stale elements",
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), "memory-refresh-"));
      roots.push(fixture);
      const file = join(fixture, "src/auth.ts");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "export function issueToken() { return 'v1'; }\n", "utf8");

      const store = await openStore();
      const first = await refreshFiles(store, [file], { rootDir: fixture });
      expect(first.files).toBe(1);
      expect(first.added).toBeGreaterThanOrEqual(2);
      expect(first.updated).toBe(0);
      expect(first.skipped).toBe(0);
      expect(first.stale).toBe(0);

      const unchanged = await refreshFiles(store, [file], { rootDir: fixture });
      expect(unchanged.files).toBe(0);
      expect(unchanged.skipped).toBe(first.added);
      expect(unchanged.added).toBe(0);
      expect(unchanged.updated).toBe(0);
      expect(unchanged.stale).toBe(0);

      await writeFile(file, "export function refreshToken() { return 'v2'; }\n", "utf8");
      const changed = await refreshFiles(store, [file], { rootDir: fixture });
      expect(changed.files).toBe(1);
      expect(changed.added).toBe(0);
      expect(changed.updated).toBeGreaterThanOrEqual(2);
      expect(changed.skipped).toBe(0);
      expect(changed.stale).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "incremental refresh stores a compact per-file manifest for docs with many references",
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), "memory-refresh-doc-"));
      roots.push(fixture);
      const file = join(fixture, "docs/links.md");
      await mkdir(dirname(file), { recursive: true });
      const links = Array.from(
        { length: 80 },
        (_, index) => `[runbook ${index}](../runbooks/runbook-${index}.md)`,
      ).join("\n");
      await writeFile(file, `# Link Map\n\n${links}\n`, "utf8");

      const store = await openStore();
      const first = await refreshFiles(store, [file], { rootDir: fixture });
      expect(first.files).toBe(1);
      expect(first.added).toBeGreaterThan(80);

      const unchanged = await refreshFiles(store, [file], { rootDir: fixture });
      expect(unchanged.files).toBe(0);
      expect(unchanged.skipped).toBe(first.added);
    },
    TIMEOUT,
  );

  test(
    "ingests IMPORTS plus compiler-resolved cross-file edges without duplicating on re-ingest",
    async () => {
      const store = await openStore();
      await ingestProject(store, { cwd: IMPORT_FIXTURE_REPO });

      const nodes = await store.listNodes();
      const file = nodes.find((n) => n.label.endsWith("/src/app.ts") && n.node_type === "file");
      const imports = nodes.filter((n) => n.node_type === "import");

      expect(imports.map((n) => n.properties.title).sort()).toEqual(["./local.js", "node:path"]);
      expect(
        imports.find((n) => n.properties.title === "./local.js")?.properties.resolved_path,
      ).toBe(join(IMPORT_FIXTURE_REPO, "src/local.js"));
      expect(imports.find((n) => n.properties.title === "node:path")?.properties.import_kind).toBe(
        "bare",
      );

      expect(file).toBeDefined();
      for (const imp of imports) {
        await expect(store.findEdge(file!.rid, imp.rid, "IMPORTS")).resolves.toBeTypeOf(
          "number",
        );
      }

      const before = await store.stats();
      await ingestProject(store, { cwd: IMPORT_FIXTURE_REPO });
      const after = await store.stats();
      expect(after.edges).toBe(before.edges);
      expect(after.nodes).toBe(before.nodes);

      const render = nodes.find((n) => n.label.endsWith("/src/app.ts#render"));
      const localValue = nodes.find((n) => n.label.endsWith("/src/local.ts#localValue"));
      const localOptions = nodes.find((n) => n.label.endsWith("/src/local.ts#LocalOptions"));
      expect(render).toBeDefined();
      expect(localValue).toBeDefined();
      expect(localOptions).toBeDefined();
      await expect(store.findEdge(render!.rid, localValue!.rid, "CALLS")).resolves.toBeTypeOf(
        "number",
      );
      await expect(store.findEdge(render!.rid, localOptions!.rid, "USES_TYPE")).resolves.toBeTypeOf(
        "number",
      );
    },
    TIMEOUT,
  );

  test(
    "recall finds an ingested import specifier",
    async () => {
      const store = await openStore();
      await ingestProject(store, { cwd: IMPORT_FIXTURE_REPO });

      const hits = await graphRecall(store, "node:path");
      expect(hits.some((h) => h.label.includes("import:") && h.label.includes("node:path"))).toBe(
        true,
      );
    },
    TIMEOUT,
  );

  test(
    "ingests SQL schema tables, columns, and foreign-key references",
    async () => {
      const store = await openStore();
      await ingestProject(store, { cwd: SQL_SCHEMA_FIXTURE_REPO });

      const nodes = await store.listNodes();
      const edges = await store.listEdges();
      const users = nodes.find((node) => node.label.endsWith("#table:users"));
      const sessions = nodes.find((node) => node.label.endsWith("#table:sessions"));
      const userId = nodes.find((node) => node.label.endsWith("#column:sessions.user_id"));

      expect(users).toMatchObject({
        node_type: "symbol",
        properties: { language: "sql", sql_kind: "table", title: "users" },
      });
      expect(sessions).toBeDefined();
      expect(userId).toMatchObject({
        node_type: "symbol",
        properties: { sql_kind: "column", sql_table: "sessions", sql_type: "uuid" },
      });
      expect(edges).toContainEqual(
        expect.objectContaining({
          from_rid: userId?.rid,
          to_rid: users?.rid,
          label: "REFERENCES",
        }),
      );

      const hits = await graphRecall(store, "sessions user_id");
      expect(hits.some((hit) => hit.label.endsWith("#column:sessions.user_id"))).toBe(true);

      const before = await store.stats();
      await ingestProject(store, { cwd: SQL_SCHEMA_FIXTURE_REPO });
      const after = await store.stats();
      expect(after.edges).toBe(before.edges);
      expect(after.nodes).toBe(before.nodes);
    },
    TIMEOUT,
  );

  test(
    "ingests heterogeneous dev workflow artifacts",
    async () => {
      const store = await openStore();
      const report = await ingestProject(store, { cwd: DEV_ARTIFACT_FIXTURE_REPO });

      expect(report.files).toBe(4);
      expect(report.nodes).toBeGreaterThanOrEqual(14);
      expect(report.edges).toBeGreaterThanOrEqual(10);

      const nodes = await store.listNodes();
      const edges = await store.listEdges();
      const npmBuild = nodes.find((node) => node.label.endsWith("package.json#build"));
      const dockerBase = nodes.find((node) => node.properties.title === "node:22-alpine");
      const ciTest = nodes.find((node) => node.label.endsWith("/.github/workflows/ci.yml#test"));
      const deploy = nodes.find((node) => node.label.endsWith("/scripts/deploy.sh#deploy_app"));

      expect(npmBuild).toMatchObject({
        node_type: "workflow",
        properties: { artifact_kind: "package-script" },
      });
      expect(dockerBase).toMatchObject({
        node_type: "import",
        properties: { import_kind: "docker image alias base" },
      });
      expect(ciTest).toMatchObject({
        node_type: "workflow",
        properties: { artifact_kind: "github-actions-job" },
      });
      expect(deploy).toMatchObject({
        node_type: "workflow",
        properties: { artifact_kind: "shell-function" },
      });
      expect(edges.filter((edge) => edge.label === "DEFINED_IN").length).toBeGreaterThanOrEqual(8);
      expect(edges.filter((edge) => edge.label === "IMPORTS").length).toBeGreaterThanOrEqual(3);

      const hits = await graphRecall(store, "pnpm lint docker deploy");
      expect(hits.some((hit) => hit.label.includes("workflow:"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "indexes binary document and media assets as deterministic file nodes",
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), "memory-assets-"));
      roots.push(fixture);
      const pdf = join(fixture, "docs", "architecture.pdf");
      const image = join(fixture, "assets", "screen.png");
      await mkdir(dirname(pdf), { recursive: true });
      await mkdir(dirname(image), { recursive: true });
      await writeFile(pdf, Buffer.from("%PDF-1.4\nredskills architecture\n"));
      await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));

      const store = await openStore();
      const report = await ingestProject(store, { cwd: fixture });

      expect(report.files).toBe(2);
      expect(report.docs).toBe(0);
      expect(report.nodes).toBe(2);

      const nodes = await store.listNodes();
      const pdfNode = nodes.find((node) => node.label.endsWith("/docs/architecture.pdf"));
      const imageNode = nodes.find((node) => node.label.endsWith("/assets/screen.png"));
      expect(pdfNode).toMatchObject({
        node_type: "file",
        properties: {
          title: "architecture.pdf",
          asset_kind: "document",
          media_type: "application/pdf",
          binary: true,
        },
      });
      expect(imageNode).toMatchObject({
        node_type: "file",
        properties: {
          title: "screen.png",
          asset_kind: "image",
          media_type: "image/png",
          binary: true,
        },
      });

      const hits = await graphRecall(store, "architecture pdf");
      expect(hits.some((hit) => hit.label.endsWith("/docs/architecture.pdf"))).toBe(true);

      const before = await store.stats();
      await ingestProject(store, { cwd: fixture });
      const after = await store.stats();
      expect(after.nodes).toBe(before.nodes);
    },
    TIMEOUT,
  );

  test(
    "ingests Rust IMPORTS edges and does not duplicate them on re-ingest",
    async () => {
      const store = await openStore();
      await ingestProject(store, { cwd: RUST_IMPORT_FIXTURE_REPO });

      const nodes = await store.listNodes();
      const file = nodes.find(
        (n) => n.label.endsWith("/src/features/session.rs") && n.node_type === "file",
      );
      const imports = nodes.filter((n) => n.node_type === "import");

      expect(imports.map((n) => n.properties.title).sort()).toEqual([
        "anyhow::Result",
        "crate::auth::Session",
        "crate::auth::TokenStore",
        "self::models::User",
        "self::models::profile::Avatar",
        "self::models::profile::Bio",
        "serde_json",
        "std::collections::HashMap",
        "super::prelude::*",
      ]);
      expect(
        imports.find((n) => n.properties.title === "std::collections::HashMap")?.properties
          .import_kind,
      ).toBe("bare");
      expect(
        imports.find((n) => n.properties.title === "crate::auth::Session")?.properties
          .resolved_path,
      ).toBe(join(RUST_IMPORT_FIXTURE_REPO, "src/auth/Session"));
      expect(
        imports.find((n) => n.properties.title === "self::models::User")?.properties
          .resolved_path,
      ).toBe(join(RUST_IMPORT_FIXTURE_REPO, "src/features/models/User"));
      expect(
        imports.find((n) => n.properties.title === "super::prelude::*")?.properties
          .resolved_path,
      ).toBe(join(RUST_IMPORT_FIXTURE_REPO, "src/prelude/*"));

      expect(file).toBeDefined();
      for (const imp of imports) {
        await expect(store.findEdge(file!.rid, imp.rid, "IMPORTS")).resolves.toBeTypeOf(
          "number",
        );
      }

      const before = await store.stats();
      await ingestProject(store, { cwd: RUST_IMPORT_FIXTURE_REPO });
      const after = await store.stats();
      expect(after.edges).toBe(before.edges);
      expect(after.nodes).toBe(before.nodes);
    },
    TIMEOUT,
  );

  test(
    "ingests Go IMPORTS edges and does not duplicate them on re-ingest",
    async () => {
      const store = await openStore();
      await ingestProject(store, { cwd: GO_IMPORT_FIXTURE_REPO });

      const nodes = await store.listNodes();
      const file = nodes.find((n) => n.label.endsWith("/src/server.go") && n.node_type === "file");
      const imports = nodes.filter((n) => n.node_type === "import");

      expect(imports.map((n) => n.properties.title).sort()).toEqual([
        "encoding/json",
        "example.com/alias",
        "example.com/blank",
        "example.com/dot",
        "example.com/group-blank",
        "example.com/group-dot",
        "fmt",
        "net/http",
      ]);
      for (const imp of imports) {
        expect(imp.properties.import_kind).toBe("bare");
        expect(imp.properties.resolved_path).toBeUndefined();
      }

      expect(file).toBeDefined();
      for (const imp of imports) {
        await expect(store.findEdge(file!.rid, imp.rid, "IMPORTS")).resolves.toBeTypeOf(
          "number",
        );
      }

      const before = await store.stats();
      await ingestProject(store, { cwd: GO_IMPORT_FIXTURE_REPO });
      const after = await store.stats();
      expect(after.edges).toBe(before.edges);
      expect(after.nodes).toBe(before.nodes);
    },
    TIMEOUT,
  );

  test(
    "ingests Python IMPORTS edges and does not duplicate them on re-ingest",
    async () => {
      const store = await openStore();
      await ingestProject(store, { cwd: PYTHON_IMPORT_FIXTURE_REPO });

      const nodes = await store.listNodes();
      const file = nodes.find(
        (n) => n.label.endsWith("/src/pkg/service.py") && n.node_type === "file",
      );
      const imports = nodes.filter((n) => n.node_type === "import");

      expect(imports.map((n) => n.properties.title).sort()).toEqual([
        "..parent.util",
        ".local.Thing",
        ".sibling",
        "collections.Counter",
        "os",
        "package.submodule",
        "pkg.*",
        "pkg.alpha",
        "pkg.beta",
        "requests",
      ]);
      expect(imports.find((n) => n.properties.title === "requests")?.properties.import_kind).toBe(
        "bare",
      );
      expect(
        imports.find((n) => n.properties.title === ".sibling")?.properties.resolved_path,
      ).toBe(join(PYTHON_IMPORT_FIXTURE_REPO, "src/pkg/sibling"));
      expect(
        imports.find((n) => n.properties.title === ".local.Thing")?.properties.resolved_path,
      ).toBe(join(PYTHON_IMPORT_FIXTURE_REPO, "src/pkg/local/Thing"));
      expect(
        imports.find((n) => n.properties.title === "..parent.util")?.properties.resolved_path,
      ).toBe(join(PYTHON_IMPORT_FIXTURE_REPO, "src/parent/util"));

      expect(file).toBeDefined();
      for (const imp of imports) {
        await expect(store.findEdge(file!.rid, imp.rid, "IMPORTS")).resolves.toBeTypeOf(
          "number",
        );
      }

      const before = await store.stats();
      await ingestProject(store, { cwd: PYTHON_IMPORT_FIXTURE_REPO });
      const after = await store.stats();
      expect(after.edges).toBe(before.edges);
      expect(after.nodes).toBe(before.nodes);
    },
    TIMEOUT,
  );

  test(
    "a malformed TS import does not block extraction from other files",
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), "memory-import-failure-"));
      roots.push(fixture);
      await mkdir(join(fixture, "src"), { recursive: true });
      await writeFile(
        join(fixture, "src/good.ts"),
        `import value from "react";\nexport function render(): string {\n  return value;\n}\n`,
        "utf8",
      );
      await writeFile(
        join(fixture, "src/bad.ts"),
        `import { broken from "./missing";\nexport function stillIndexed(): boolean {\n  return true;\n}\n`,
        "utf8",
      );

      const store = await openStore();
      await ingestProject(store, { cwd: fixture });

      const nodes = await store.listNodes();
      expect(nodes.some((n) => n.properties.title === "render")).toBe(true);
      expect(nodes.some((n) => n.properties.title === "stillIndexed")).toBe(true);
      expect(nodes.some((n) => n.node_type === "import" && n.properties.title === "./missing")).toBe(
        false,
      );
      expect(nodes.some((n) => n.node_type === "import" && n.properties.title === "react")).toBe(
        true,
      );
    },
    TIMEOUT,
  );

  test(
    "a malformed Rust use does not block extraction from other files",
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), "memory-rust-import-failure-"));
      roots.push(fixture);
      await mkdir(join(fixture, "src"), { recursive: true });
      await writeFile(
        join(fixture, "src/good.rs"),
        `use std::fmt::Debug;\npub fn render() {}\n`,
        "utf8",
      );
      await writeFile(
        join(fixture, "src/bad.rs"),
        `use crate::{broken;\npub fn still_indexed() {}\n`,
        "utf8",
      );

      const store = await openStore();
      await ingestProject(store, { cwd: fixture });

      const nodes = await store.listNodes();
      expect(nodes.some((n) => n.properties.title === "render")).toBe(true);
      expect(nodes.some((n) => n.properties.title === "still_indexed")).toBe(true);
      expect(
        nodes.some((n) => n.node_type === "import" && n.properties.title === "crate::broken"),
      ).toBe(false);
      expect(
        nodes.some((n) => n.node_type === "import" && n.properties.title === "std::fmt::Debug"),
      ).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "a malformed Go import does not block extraction from other files",
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), "memory-go-import-failure-"));
      roots.push(fixture);
      await mkdir(join(fixture, "src"), { recursive: true });
      await writeFile(
        join(fixture, "src/good.go"),
        `package main\n\nimport "fmt"\n\nfunc Render() string { return fmt.Sprint("ok") }\n`,
        "utf8",
      );
      await writeFile(
        join(fixture, "src/bad.go"),
        `package main\n\nimport (\n  "broken"\n\nfunc StillIndexed() bool { return true }\n`,
        "utf8",
      );

      const store = await openStore();
      await ingestProject(store, { cwd: fixture });

      const nodes = await store.listNodes();
      expect(nodes.some((n) => n.properties.title === "Render")).toBe(true);
      expect(nodes.some((n) => n.properties.title === "StillIndexed")).toBe(true);
      expect(nodes.some((n) => n.node_type === "import" && n.properties.title === "broken")).toBe(
        false,
      );
      expect(nodes.some((n) => n.node_type === "import" && n.properties.title === "fmt")).toBe(
        true,
      );
    },
    TIMEOUT,
  );

  test(
    "a malformed Python import does not block extraction from other files",
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), "memory-python-import-failure-"));
      roots.push(fixture);
      await mkdir(join(fixture, "src"), { recursive: true });
      await writeFile(
        join(fixture, "src/good.py"),
        `import json\n\ndef render():\n    return json.dumps({})\n`,
        "utf8",
      );
      await writeFile(
        join(fixture, "src/bad.py"),
        `from broken import (\n\ndef still_indexed():\n    return True\n`,
        "utf8",
      );

      const store = await openStore();
      await ingestProject(store, { cwd: fixture });

      const nodes = await store.listNodes();
      expect(nodes.some((n) => n.properties.title === "render")).toBe(true);
      expect(nodes.some((n) => n.properties.title === "still_indexed")).toBe(true);
      expect(nodes.some((n) => n.node_type === "import" && n.properties.title === "broken.")).toBe(
        false,
      );
      expect(nodes.some((n) => n.node_type === "import" && n.properties.title === "json")).toBe(
        true,
      );
    },
    TIMEOUT,
  );
});
