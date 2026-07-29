import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CASTLE_PUBLISHED_CONTRACTS } from "./index.js";

const repoRoot = resolve(import.meta.dirname, "../../../../..");

describe("castle published contract docs", () => {
  it("documents every exported contract schema, type, and field", () => {
    for (const contract of CASTLE_PUBLISHED_CONTRACTS) {
      const doc = readFileSync(resolve(repoRoot, contract.docPath), "utf8");

      expect(doc, contract.docPath).toContain(
        `schema id: \`${contract.schemaId}\``,
      );
      for (const typeName of contract.typeNames) {
        expect(doc, `${contract.docPath} documents ${typeName}`).toContain(
          `\`${typeName}\``,
        );
      }
      for (const field of contract.fields) {
        expect(doc, `${contract.docPath} documents ${field}`).toContain(
          `\`${field}\``,
        );
      }
    }
  });

  it("keeps the docs set one-to-one with the published contract list", async () => {
    const docsDir = resolve(repoRoot, ".red/contracts");
    const docs = (await (await import("node:fs/promises")).readdir(docsDir))
      .filter((entry) => entry.endsWith(".md"))
      .sort();
    expect(docs).toEqual(
      CASTLE_PUBLISHED_CONTRACTS.map((contract) =>
        contract.docPath.replace(".red/contracts/", ""),
      ).sort(),
    );
  });

  /**
   * The Attempt is extinct (Spec #2772): since a retry became a fresh Worker, a
   * Worker already IS one Worker × one Ticket × one try, so an attempt contract
   * published a synonym. This asserts the extinction on the SCHEMA ID, not on a
   * type name — a contract could come back under a new spelling and still be the
   * same second copy of facts the tracker and git already own.
   */
  it("publishes no attempt contract", () => {
    expect(
      CASTLE_PUBLISHED_CONTRACTS.map((contract) => contract.schemaId),
    ).not.toContain("red.castle.attempt.v1");
  });
});
