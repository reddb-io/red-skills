import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { graphRecall } from "../src/graph-recall.js";
import { MemoryStore } from "../src/graph-store.js";
import { ingestProject } from "../src/ingest.js";

// RedDB connects by spawning the bundled `red` binary; give each test room.
const TIMEOUT = 30_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = join(HERE, "fixtures/repo");
const IMPORT_FIXTURE_REPO = join(HERE, "fixtures/imports");
const RUST_IMPORT_FIXTURE_REPO = join(HERE, "fixtures/rust-imports");

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
      // file + 5 symbols, root concept + 3 heading concepts.
      expect(report.nodes).toBeGreaterThanOrEqual(6 + 4);

      const { nodes } = await store.stats();
      expect(nodes).toBe(report.nodes);
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
    "ingests IMPORTS edges and does not duplicate them on re-ingest",
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
});
