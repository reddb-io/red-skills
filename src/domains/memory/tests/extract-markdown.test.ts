import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { extractMarkdown } from "../src/extract-markdown.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MD_FIXTURE = join(HERE, "fixtures/repo/docs/guide.md");

describe("extractMarkdown", () => {
  test("builds a root concept node from frontmatter title and tags", async () => {
    const { nodes, doc } = await extractMarkdown(MD_FIXTURE);

    const root = nodes.find((n) => n.label === `md:${MD_FIXTURE}`);
    expect(root?.node_type).toBe("concept");
    expect(root?.properties.title).toBe("Auth Guide");
    expect(root?.properties.tags).toEqual(["auth", "security"]);
    expect(root?.properties.confidence).toBe("EXTRACTED");

    expect(doc.frontmatter?.title).toBe("Auth Guide");
    expect(doc.body).toContain("Token Rotation");
  });

  test("emits one concept node per h1–h3 heading", async () => {
    const { nodes } = await extractMarkdown(MD_FIXTURE);
    const titles = nodes
      .filter((n) => n.node_type === "concept" && n.label.includes("#"))
      .map((n) => n.properties.title);

    expect(titles).toContain("Auth Guide");
    expect(titles).toContain("Token Rotation");
    expect(titles).toContain("Threat Model");
  });

  test("grounds wiki-links and inline identifiers as referenced entity nodes", async () => {
    const { edges, doc, nodes } = await extractMarkdown(MD_FIXTURE);
    const entities = nodes.filter((n) => n.properties.entity_kind);
    const entityTitles = entities.map((n) => n.properties.title).sort();
    const targets = edges.map((e) => e.toLabel);

    expect(entityTitles).toEqual([
      "../runbooks/incidents.md",
      "JWT_SECRET",
      "Session",
      "TokenStore",
    ]);
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "entity:jwt_secret",
          node_type: "concept",
          properties: expect.objectContaining({
            title: "JWT_SECRET",
            entity_kind: "identifier",
            confidence: "EXTRACTED",
          }),
        }),
        expect.objectContaining({
          label: "entity:tokenstore",
          properties: expect.objectContaining({
            title: "TokenStore",
            entity_kind: "wikilink",
          }),
        }),
        expect.objectContaining({
          label: "entity:../runbooks/incidents.md",
          properties: expect.objectContaining({
            title: "../runbooks/incidents.md",
            entity_kind: "link",
          }),
        }),
      ]),
    );
    expect(edges.every((e) => e.label === "REFERENCES")).toBe(true);
    expect(edges.every((e) => e.fromHash === doc.hash)).toBe(true);
    expect(targets).toContain("entity:tokenstore");
    expect(targets).toContain("entity:session");
    expect(targets).toContain("entity:jwt_secret");
    expect(targets).toContain("entity:../runbooks/incidents.md");
  });
});
