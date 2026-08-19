import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(__dirname, "..", "src");
const wirePackage = join(__dirname, "..", "..", "..", "packages", "protocol-acp");

describe("the ACP control-plane module boundary", () => {
  it("keeps the public control plane at or below its headroom target", async () => {
    const source = await readFile(join(sourceRoot, "acp-control-plane.ts"), "utf8");

    expect(source.split("\n").length - 1).toBeLessThanOrEqual(700);
  });

  it("takes compatibility negotiation and socket plumbing from the shared wire package", async () => {
    const [controlPlane, compatibility, transport] = await Promise.all([
      readFile(join(sourceRoot, "acp-control-plane.ts"), "utf8"),
      readFile(join(wirePackage, "compat.ts"), "utf8"),
      readFile(join(wirePackage, "transport.ts"), "utf8"),
    ]);

    expect(controlPlane).toContain('from "@reddb-io/protocol-acp"');
    expect(controlPlane).not.toContain('from "./acp-compat.js"');
    expect(controlPlane).not.toContain('from "./acp-socket.js"');
    expect(compatibility).toContain("requireCompatibleWireMajor");
    expect(transport).toContain("connectWithDeadline");
  });

  it("keeps child-stream semantics in the Workflow Worker", async () => {
    const [controlPlane, workflowTurn, childAgent] = await Promise.all([
      readFile(join(sourceRoot, "acp-control-plane.ts"), "utf8"),
      readFile(join(sourceRoot, "acp-workflow-turn.ts"), "utf8"),
      readFile(join(sourceRoot, "acp-child-agent.ts"), "utf8"),
    ]);

    expect(controlPlane).not.toMatch(/evaluateSpin|createChildAcpSpinEpisode|SpinPattern/);
    expect(workflowTurn).not.toMatch(/evaluateSpin|createChildAcpSpinEpisode|SpinPattern/);
    expect(childAgent).toContain("createChildAcpSpinEpisode");
  });
});
