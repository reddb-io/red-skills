import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { extractDevArtifact } from "../src/extract-dev-artifact.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures/dev-artifacts");

describe("extractDevArtifact", () => {
  test("extracts package scripts as workflow nodes", async () => {
    const path = join(FIXTURE, "package.json");
    const { nodes, edges } = await extractDevArtifact(path);

    expect(nodes.find((node) => node.node_type === "file")).toMatchObject({
      label: `file:${path}`,
      properties: { language: "json" },
    });
    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: `workflow:${path}#build`,
          node_type: "workflow",
          properties: expect.objectContaining({
            title: "npm script build",
            artifact_kind: "package-script",
          }),
        }),
        expect.objectContaining({
          label: `workflow:${path}#test:ci`,
          node_type: "workflow",
        }),
      ]),
    );
    expect(edges).toContainEqual({
      fromLabel: `workflow:${path}#build`,
      toLabel: `file:${path}`,
      label: "DEFINED_IN",
    });
  });

  test("extracts Dockerfile stages and steps", async () => {
    const path = join(FIXTURE, "Dockerfile");
    const { nodes, edges } = await extractDevArtifact(path);

    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: `import:${path}#node:22-alpine`,
          node_type: "import",
          properties: expect.objectContaining({ import_kind: "docker image alias base" }),
        }),
        expect.objectContaining({
          label: `workflow:${path}#run-2`,
          node_type: "workflow",
          properties: expect.objectContaining({ artifact_kind: "docker-step" }),
        }),
      ]),
    );
    expect(edges).toContainEqual({
      fromLabel: `file:${path}`,
      toLabel: `import:${path}#node:22-alpine`,
      label: "IMPORTS",
    });
  });

  test("extracts GitHub Actions jobs and reusable actions", async () => {
    const path = join(FIXTURE, ".github/workflows/ci.yml");
    const { nodes } = await extractDevArtifact(path);

    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: `workflow:${path}#test`,
          node_type: "workflow",
          properties: expect.objectContaining({ artifact_kind: "github-actions-job" }),
        }),
        expect.objectContaining({
          label: `workflow:${path}#lint`,
          node_type: "workflow",
        }),
        expect.objectContaining({
          label: `import:${path}#actions-checkout-v4`,
          node_type: "import",
          properties: expect.objectContaining({ import_kind: "github action" }),
        }),
      ]),
    );
  });

  test("extracts shell functions as workflows", async () => {
    const path = join(FIXTURE, "scripts/deploy.sh");
    const { nodes } = await extractDevArtifact(path);

    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: `workflow:${path}#deploy_app`,
          node_type: "workflow",
          properties: expect.objectContaining({ artifact_kind: "shell-function" }),
        }),
        expect.objectContaining({
          label: `workflow:${path}#rollback_app`,
          node_type: "workflow",
        }),
      ]),
    );
  });
});
