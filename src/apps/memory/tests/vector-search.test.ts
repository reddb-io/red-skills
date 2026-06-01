import { describe, expect, test } from "vitest";
import { buildVectorSearchReport, type VectorSearchStore } from "../src/vector-search.js";

describe("vector search diagnostics", () => {
  test("enriches grounded vector rows with node metadata and dedupes by rid", async () => {
    const store: VectorSearchStore = {
      async searchVector(_query, limit) {
        expect(limit).toBe(5);
        return [
          { rid: 2, score: 0.4 },
          { rid: 1, score: 0.9 },
          { rid: 2, score: 0.8 },
          { rid: 404, score: 1 },
        ];
      },
      async getNode(rid) {
        if (rid === 1) {
          return {
            rid,
            label: "jwt-rotation",
            node_type: "decision",
            properties: {
              title: "JWT rotation",
              summary: "JWT tokens rotate every 90 days.",
              confidence: "EXTRACTED",
              source: "docs/jwt.md",
            },
          };
        }
        if (rid === 2) {
          return {
            rid,
            label: "cache-ttl",
            node_type: "concept",
            properties: {
              title: "Cache TTL",
              content: "Redis cache TTL is 300 seconds.",
            },
          };
        }
        return null;
      },
    };

    const report = await buildVectorSearchReport(store, "jwt cache", { limit: 5 });

    expect(report).toMatchObject({
      query: "jwt cache",
      limit: 5,
      status: "available",
      read_only: true,
    });
    expect(report.hits).toEqual([
      {
        rid: 2,
        score: 0.8,
        kind: "memory",
        label: "cache-ttl",
        node_type: "concept",
        title: "Cache TTL",
        excerpt: "Redis cache TTL is 300 seconds.",
        confidence: "INFERRED",
        source: null,
      },
      {
        rid: 1,
        score: 0.9,
        kind: "memory",
        label: "jwt-rotation",
        node_type: "decision",
        title: "JWT rotation",
        excerpt: "JWT tokens rotate every 90 days.",
        confidence: "EXTRACTED",
        source: "docs/jwt.md",
      },
    ]);
  });

  test("preserves asset metadata on vector diagnostics", async () => {
    const store: VectorSearchStore = {
      async searchVector() {
        return [{ rid: 3, score: 0.72 }];
      },
      async getNode(rid) {
        if (rid !== 3) return null;
        return {
          rid,
          label: "asset:docs/architecture.pdf",
          node_type: "file",
          properties: {
            title: "architecture.pdf",
            summary: "Architecture blueprint asset for service boundaries.",
            source: "docs/architecture.pdf",
            asset_kind: "document",
            media_type: "application/pdf",
            confidence: "EXTRACTED",
          },
        };
      },
    };

    await expect(buildVectorSearchReport(store, "service blueprint")).resolves.toMatchObject({
      status: "available",
      hits: [
        {
          rid: 3,
          kind: "asset",
          path: "docs/architecture.pdf",
          asset_kind: "document",
          media_type: "application/pdf",
          title: "architecture.pdf",
        },
      ],
    });
  });

  test("returns unavailable diagnostics instead of throwing provider errors", async () => {
    const store: VectorSearchStore = {
      async searchVector() {
        throw new Error("RED_MEMORY_VECTOR_PROVIDER is not configured");
      },
      async getNode() {
        throw new Error("should not read nodes after vector failure");
      },
    };

    await expect(buildVectorSearchReport(store, "jwt")).resolves.toMatchObject({
      query: "jwt",
      limit: 20,
      status: "unavailable",
      hits: [],
      error: "RED_MEMORY_VECTOR_PROVIDER is not configured",
      read_only: true,
    });
  });
});
