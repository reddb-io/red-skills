import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { REDSKILLS_ACP_METHODS, REDSKILLS_ACP_METHOD_NAMES } from "@reddb-io/protocol-acp";

import { REDSKILLS_ACP_METHOD_DOMAINS } from "../src/acp-method-registry.js";

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

// One module per method domain (#4014). The control plane used to bind every
// `_redskills/*` method itself, twice, which meant every new method landed in
// the same file as every old one — and a slice adding a method could not be
// written without touching the file every other slice was touching.
describe("the `_redskills/*` method domains", () => {
  it("gives every declared method exactly one owning domain", () => {
    const owners = new Map<string, string>();
    for (const domain of REDSKILLS_ACP_METHOD_DOMAINS) {
      for (const key of domain.methods) {
        const method = REDSKILLS_ACP_METHODS[key];
        expect(owners.get(method), `${method} is claimed twice`).toBeUndefined();
        owners.set(method, domain.domain);
      }
    }
    expect([...owners.keys()].sort()).toEqual([...REDSKILLS_ACP_METHOD_NAMES].sort());
  });

  it("gives every domain its own module, and no two domains the same one", () => {
    const modules = REDSKILLS_ACP_METHOD_DOMAINS.map((domain) => domain.module);

    expect(new Set(modules).size).toBe(modules.length);
    expect(new Set(REDSKILLS_ACP_METHOD_DOMAINS.map((entry) => entry.domain)).size)
      .toBe(REDSKILLS_ACP_METHOD_DOMAINS.length);
  });

  it("spells each domain's method keys in that domain's module and nowhere else", async () => {
    const sources = new Map<string, string>();
    for (const domain of REDSKILLS_ACP_METHOD_DOMAINS) {
      sources.set(domain.module, await readFile(join(sourceRoot, domain.module), "utf8"));
    }

    const misplaced: string[] = [];
    for (const domain of REDSKILLS_ACP_METHOD_DOMAINS) {
      for (const key of domain.methods) {
        const spelling = `REDSKILLS_ACP_METHODS.${key}`;
        if (!sources.get(domain.module)!.includes(spelling)) {
          misplaced.push(`${domain.module} never names ${spelling}`);
        }
        for (const [module, source] of sources) {
          if (module === domain.module || !source.includes(spelling)) continue;
          misplaced.push(`${module} names ${spelling}, owned by the ${domain.domain} domain`);
        }
      }
    }
    expect(misplaced, misplaced.join("\n")).toEqual([]);
  });

  it("keeps the control plane out of the binding business entirely", async () => {
    const controlPlane = await readFile(join(sourceRoot, "acp-control-plane.ts"), "utf8");

    expect(controlPlane).not.toMatch(/REDSKILLS_ACP_METHODS\./);
    expect(controlPlane).toContain("connectionMethodTables");
  });

  it("binds every control-plane-served domain onto both dialects", async () => {
    const composed = await readFile(join(sourceRoot, "acp-connection-methods.ts"), "utf8");

    for (const domain of REDSKILLS_ACP_METHOD_DOMAINS.filter((entry) => entry.served)) {
      const specifier = `from "./${domain.module.replace(/\.ts$/, ".js")}"`;
      expect(composed, `the ${domain.domain} domain is never composed`).toContain(specifier);
    }
    expect(composed).toContain("v1: table(");
    expect(composed).toContain("v2: table(");
  });
});
