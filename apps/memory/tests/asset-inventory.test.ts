import { describe, expect, test } from "vitest";
import {
  buildMemoryAssetInventory,
  type AssetInventoryStore,
} from "../src/asset-inventory.js";
import { buildMemoryAssetInventoryViewerArtifact } from "../src/asset-inventory-viewer.js";

describe("asset inventory report", () => {
  test("reports RedDB-indexed binary document and media assets", async () => {
    const store: AssetInventoryStore = {
      async listNodes() {
        return [
          {
            rid: 1,
            label: "asset:docs/architecture.pdf",
            node_type: "file",
            properties: {
              title: "architecture.pdf",
              source: "docs/architecture.pdf",
              asset_kind: "document",
              media_type: "application/pdf",
              bytes: 1200,
              binary: true,
              hash: "pdfhash",
            },
          },
          {
            rid: 2,
            label: "asset:assets/screen.png",
            node_type: "file",
            properties: {
              title: "screen.png",
              source: "assets/screen.png",
              asset_kind: "image",
              media_type: "image/png",
              bytes: 800,
              binary: true,
              hash: "pnghash",
            },
          },
          {
            rid: 3,
            label: "md:docs/guide.md",
            node_type: "concept",
            properties: { title: "Guide" },
          },
        ];
      },
    };

    const report = await buildMemoryAssetInventory(store);

    expect(report).toMatchObject({
      schema_version: "memory.asset_inventory.v1",
      read_only: true,
      query: null,
      total_assets: 2,
      total_bytes: 2000,
      kinds: [
        { kind: "document", count: 1, bytes: 1200 },
        { kind: "image", count: 1, bytes: 800 },
      ],
      assets: [
        expect.objectContaining({
          path: "assets/screen.png",
          asset_kind: "image",
          media_type: "image/png",
        }),
        expect.objectContaining({
          path: "docs/architecture.pdf",
          asset_kind: "document",
          media_type: "application/pdf",
        }),
      ],
      warnings: [],
    });

    const filtered = await buildMemoryAssetInventory(store, { kind: "image" });
    expect(filtered.total_assets).toBe(1);
    expect(filtered.assets[0]?.path).toBe("assets/screen.png");

    const queried = await buildMemoryAssetInventory(store, { query: "pdf architecture" });
    expect(queried.query).toBe("pdf architecture");
    expect(queried.total_assets).toBe(1);
    expect(queried.assets[0]?.path).toBe("docs/architecture.pdf");

    const artifact = buildMemoryAssetInventoryViewerArtifact(report);
    expect(artifact.contract).toEqual({
      name: "memory.asset_inventory.viewer",
      version: "memory.asset_inventory.viewer.v1",
      consumes: "memory.asset_inventory.v1",
    });
    expect(artifact.html).toContain("Asset Inventory");
    expect(artifact.html).toContain("architecture.pdf");
    expect(artifact.html).toContain('id="asset-inventory-data"');
  });
});
