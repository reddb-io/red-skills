import { describe, expect, it } from "vitest";
import { parseConfigYaml } from "../src/core/config.js";
import {
  declaredHitlTypeLabels,
  hitlTypeLabelsAmong,
  installTypeLabels,
  planHitlTypeDeclaration,
  WAYFINDER_HITL_TYPE_LABELS,
  WAYFINDER_TYPE_LABELS,
  type TypeLabelInstallDeps,
} from "../src/core/hitl-type-declaration.js";

function declaredIn(text: string): string[] {
  return declaredHitlTypeLabels(parseConfigYaml(text));
}

describe("hitl type vocabulary", () => {
  it("names only the HITL half of the wayfinder type vocabulary", () => {
    expect(WAYFINDER_TYPE_LABELS).toContain("wayfinder:research");
    expect(WAYFINDER_TYPE_LABELS).toContain("wayfinder:task");
    // research and task are AFK types: declaring them human-only would park
    // work the agent is supposed to run.
    expect([...WAYFINDER_HITL_TYPE_LABELS]).toEqual(["wayfinder:grilling", "wayfinder:prototype"]);
  });

  it("selects the HITL types among an arbitrary installed label set", () => {
    expect(
      hitlTypeLabelsAmong(["bug", "wayfinder:map", "wayfinder:research", "wayfinder:prototype"]),
    ).toEqual(["wayfinder:prototype"]);
    expect(hitlTypeLabelsAmong(["bug", "ready-for-agent"])).toEqual([]);
  });
});

describe("planHitlTypeDeclaration", () => {
  it("creates the canonical block in a config that has no afk block", () => {
    const before = "plugins:\n  dev:\n    enabled: true\n";
    const plan = planHitlTypeDeclaration(before, WAYFINDER_HITL_TYPE_LABELS);

    expect(plan.changed).toBe(true);
    expect(plan.added).toEqual(["wayfinder:grilling", "wayfinder:prototype"]);
    expect(declaredIn(plan.after)).toEqual(["wayfinder:grilling", "wayfinder:prototype"]);
    // The declaration lands under the existing plugins.dev block, not as a
    // second top-level tree.
    expect(plan.after.match(/^plugins:/gm)).toHaveLength(1);
  });

  it("creates the whole canonical tree when the config is absent or empty", () => {
    for (const before of [undefined, "", "# only a comment\n"]) {
      const plan = planHitlTypeDeclaration(before, ["wayfinder:grilling"]);
      expect(plan.changed).toBe(true);
      expect(declaredIn(plan.after)).toEqual(["wayfinder:grilling"]);
      expect(plan.after.endsWith("\n")).toBe(true);
    }
  });

  it("appends into an existing list without overwriting or duplicating it", () => {
    const before = [
      "plugins:",
      "  dev:",
      "    afk:",
      "      labels:",
      "        hitl_types:",
      "          - decision:grilling",
      "          - wayfinder:grilling",
      "    review:",
      "      enabled: false",
      "",
    ].join("\n");
    const plan = planHitlTypeDeclaration(before, WAYFINDER_HITL_TYPE_LABELS);

    expect(plan.added).toEqual(["wayfinder:prototype"]);
    expect(plan.alreadyDeclared).toEqual(["wayfinder:grilling"]);
    expect(declaredIn(plan.after)).toEqual([
      "decision:grilling",
      "wayfinder:grilling",
      "wayfinder:prototype",
    ]);
    // The repo's own name survives, and the sibling block is untouched.
    expect(plan.after).toContain("    review:\n      enabled: false");
  });

  it("merges into a root-level afk block rather than minting a rival one", () => {
    const before = "afk:\n  labels:\n    hitl_types:\n      - wayfinder:grilling\n";
    const plan = planHitlTypeDeclaration(before, WAYFINDER_HITL_TYPE_LABELS);

    expect(plan.changed).toBe(true);
    expect(plan.after.match(/hitl_types:/g)).toHaveLength(1);
    expect(declaredIn(plan.after)).toEqual(["wayfinder:grilling", "wayfinder:prototype"]);
  });

  it("promotes a single-line scalar declaration into a list, keeping its value", () => {
    const before = "plugins:\n  dev:\n    afk:\n      labels:\n        hitl_types: wayfinder:grilling\n";
    const plan = planHitlTypeDeclaration(before, WAYFINDER_HITL_TYPE_LABELS);

    expect(declaredIn(plan.after)).toEqual(["wayfinder:grilling", "wayfinder:prototype"]);
  });

  it("is a no-op when every type is already declared", () => {
    const before = [
      "plugins:",
      "  dev:",
      "    afk:",
      "      labels:",
      "        hitl_types:",
      "          - wayfinder:grilling",
      "          - wayfinder:prototype",
      "",
    ].join("\n");
    const plan = planHitlTypeDeclaration(before, WAYFINDER_HITL_TYPE_LABELS);

    expect(plan.changed).toBe(false);
    expect(plan.after).toBe(before);
    expect(plan.added).toEqual([]);
    expect(plan.alreadyDeclared).toEqual(["wayfinder:grilling", "wayfinder:prototype"]);
  });

  it("refuses to edit a config the loader itself cannot parse", () => {
    const plan = planHitlTypeDeclaration("plugins:\n   dev: \"unclosed\n", ["wayfinder:grilling"]);

    expect(plan.changed).toBe(false);
    expect(plan.refusal).toContain("does not parse");
  });

  it("shows the inserted lines as a diff so an operator can review the edit", () => {
    const plan = planHitlTypeDeclaration("plugins:\n  dev:\n    enabled: true\n", ["wayfinder:grilling"]);

    expect(plan.diff).toContain("+          - wayfinder:grilling");
    expect(plan.diff).toContain(".red/config.yaml");
  });
});

describe("installTypeLabels", () => {
  function recordingDeps(configText: string | null): {
    deps: TypeLabelInstallDeps;
    order: string[];
    config: () => string | null;
  } {
    let text = configText;
    const order: string[] = [];
    return {
      order,
      config: () => text,
      deps: {
        ensureLabel: async (name) => {
          order.push(`label:${name}`);
        },
        readConfig: async () => text,
        writeConfig: async (next) => {
          order.push("config");
          text = next;
        },
      },
    };
  }

  it("leaves a fresh setup declaring every HITL type it just installed", async () => {
    // What /red-setup leaves behind before it provisions labels: the activated
    // config, no declaration yet.
    const { deps, order, config } = recordingDeps("plugins:\n  dev:\n    enabled: true\n");

    const receipt = await installTypeLabels(WAYFINDER_TYPE_LABELS, deps);

    expect(receipt.installed).toEqual([...WAYFINDER_TYPE_LABELS]);
    expect(receipt.declared).toEqual(["wayfinder:grilling", "wayfinder:prototype"]);
    expect(receipt.configChanged).toBe(true);
    expect(declaredIn(config() ?? "")).toEqual(["wayfinder:grilling", "wayfinder:prototype"]);
    // The safety half is written BEFORE the trigger half: a config write that
    // fails must not leave a repo carrying human-only labels nothing routes.
    expect(order[0]).toBe("config");
    expect(order.filter((entry) => entry.startsWith("label:"))).toHaveLength(WAYFINDER_TYPE_LABELS.length);
  });

  it("installs AFK-only types without touching the declaration", async () => {
    const { deps, order, config } = recordingDeps("plugins:\n  dev:\n    enabled: true\n");

    const receipt = await installTypeLabels(["wayfinder:research"], deps);

    expect(receipt.declared).toEqual([]);
    expect(receipt.configChanged).toBe(false);
    expect(order).toEqual(["label:wayfinder:research"]);
    expect(config()).toBe("plugins:\n  dev:\n    enabled: true\n");
  });

  it("re-running the installer neither duplicates the label nor the declaration", async () => {
    const { deps, config } = recordingDeps("plugins:\n  dev:\n    enabled: true\n");

    await installTypeLabels(WAYFINDER_HITL_TYPE_LABELS, deps);
    const afterFirst = config();
    const receipt = await installTypeLabels(WAYFINDER_HITL_TYPE_LABELS, deps);

    expect(receipt.configChanged).toBe(false);
    expect(receipt.alreadyDeclared).toEqual(["wayfinder:grilling", "wayfinder:prototype"]);
    expect(config()).toBe(afterFirst);
  });

  it("refuses without an existing .red/config.yaml, which only /red-setup creates", async () => {
    const { deps, order } = recordingDeps(null);

    const receipt = await installTypeLabels(WAYFINDER_HITL_TYPE_LABELS, deps);

    expect(receipt.refusal).toContain("/red-setup");
    expect(receipt.installed).toEqual([]);
    expect(order).toEqual([]);
  });

  it("installs no label when the declaration cannot be written", async () => {
    const order: string[] = [];
    const deps: TypeLabelInstallDeps = {
      ensureLabel: async (name) => {
        order.push(`label:${name}`);
      },
      readConfig: async () => "plugins:\n   dev: \"unclosed\n",
      writeConfig: async () => {
        order.push("config");
      },
    };

    const receipt = await installTypeLabels(WAYFINDER_HITL_TYPE_LABELS, deps);

    expect(receipt.refusal).toContain("does not parse");
    expect(receipt.installed).toEqual([]);
    expect(order).toEqual([]);
  });
});
