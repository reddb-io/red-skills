/**
 * The standing declaration, read and resolved (#4293).
 *
 * `plugins.dev.afk.standing: {runner, target}` is documented as the way a
 * project keeps itself registered. Until this landed nothing read it in
 * production, so the block was decorative: `drain` composed its argv from the
 * tool call alone and a call with no runner dropped the declared one.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  declaredStandingDrain,
  formatStandingDrainReading,
  readProjectStandingDrain,
  readStandingDrainDeclaration,
  resolveDrainRunner,
  resolveDrainTarget,
  STANDING_DRAIN_KEYS,
} from "../src/core/standing-drain-declaration.js";

function checkout(configYaml: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "standing-drain-"));
  if (configYaml != null) {
    mkdirSync(join(root, ".red"), { recursive: true });
    writeFileSync(join(root, ".red", "config.yaml"), configYaml, "utf8");
  }
  return root;
}

const DECLARED = `plugins:
  dev:
    enabled: true
    afk:
      standing:
        runner: claude-code
        target: 1
`;

describe("what the afk.standing block says", () => {
  it("reads a complete declaration", () => {
    expect(readStandingDrainDeclaration({
      "afk.standing.runner": "claude-code",
      "afk.standing.target": "3",
    })).toEqual({ kind: "declared", standing: { runner: "claude-code", target: 3 } });
  });

  it("calls silence absent — the opt-in default, never a fault", () => {
    expect(readStandingDrainDeclaration({})).toEqual({ kind: "absent" });
  });

  it("names the leaf a half-written block left empty", () => {
    expect(readStandingDrainDeclaration({ "afk.standing.runner": "claude-code" })).toEqual({
      kind: "incomplete",
      stated: ["afk.standing.runner"],
      missing: ["afk.standing.target"],
    });
  });

  it("calls a fully-stated block with an unusable value incomplete, not absent", () => {
    const reading = readStandingDrainDeclaration({
      "afk.standing.runner": "not-a-runner",
      "afk.standing.target": "0",
    });

    expect(reading).toEqual({ kind: "incomplete", stated: [...STANDING_DRAIN_KEYS], missing: [] });
    expect(formatStandingDrainReading("/repo", reading)).toContain("claude-code");
  });

  it("says where an operator can see that an incomplete block stayed inert", () => {
    const line = formatStandingDrainReading(
      "/repo",
      readStandingDrainDeclaration({ "afk.standing.target": "2" }),
    );

    expect(line).toContain("/repo");
    expect(line).toContain("afk.standing.runner");
    expect(line).toContain("no drain was registered");
  });

  it("says nothing about a complete or an absent declaration", () => {
    expect(formatStandingDrainReading("/repo", { kind: "absent" })).toBe("");
  });
});

describe("what a checkout declares", () => {
  it("reads the declaration out of .red/config.yaml", () => {
    expect(declaredStandingDrain(checkout(DECLARED))).toEqual({ runner: "claude-code", target: 1 });
  });

  it("declares nothing for a checkout with no .red/ at all", () => {
    const root = checkout(null);

    expect(readProjectStandingDrain(root)).toEqual({ kind: "absent" });
    expect(declaredStandingDrain(root)).toBeNull();
  });
});

describe("the resolution order", () => {
  const standing = { runner: "claude-code", target: 1 } as const;

  it("lets an explicitly stated runner win over the declaration", () => {
    expect(resolveDrainRunner("redcode", standing)).toBe("redcode");
  });

  it("falls back to the declared runner when the caller states none", () => {
    expect(resolveDrainRunner(undefined, standing)).toBe("claude-code");
  });

  it("leaves a repo that declared nothing unchanged — no runner, the governed default", () => {
    expect(resolveDrainRunner(undefined, null)).toBeUndefined();
    expect(resolveDrainTarget(undefined, null)).toBe(1);
  });

  it("prefers a stated target, including the deliberate zero", () => {
    expect(resolveDrainTarget(4, { runner: "claude-code", target: 2 })).toBe(4);
    expect(resolveDrainTarget(0, { runner: "claude-code", target: 2 })).toBe(0);
  });

  it("falls back to the declared target when the caller states none", () => {
    expect(resolveDrainTarget(undefined, { runner: "claude-code", target: 3 })).toBe(3);
  });
});
