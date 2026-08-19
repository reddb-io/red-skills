// pr-medic.test.ts — the mechanical CI/conflict healer (#2513, Spec #2511
// slice 2). The medic heals exactly the classes hand-fixed on 2026-07-22
// (stale Pi mirrors, registered identifier renames, additive conflicts) and
// escalates everything else untouched, bounded at MEDIC_MAX_ROUNDS rounds.

import { describe, expect, it, vi } from "vitest";
import {
  MEDIC_MAX_ROUNDS,
  applyRenameRegistry,
  classifyMedicFailure,
  runMedicPass,
  unionResolveConflicts,
  type MedicIo,
  type MedicState,
  type MedicStore,
} from "../src/core/pr-medic.js";

const NOW = 1_800_000_000;

function memoryStore(initial?: MedicState): MedicStore & { value: MedicState } {
  return {
    value: initial ?? { version: 1, prs: {} },
    async read() {
      return this.value;
    },
    async write(state) {
      this.value = state;
    },
  };
}

function makeIo(diagnosis: {
  logTail?: string;
  conflicts?: Record<string, string>;
  files?: Record<string, string>;
}): MedicIo & {
  regenPi: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  commitPush: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
} {
  return {
    diagnose: vi.fn(async () => ({
      logTail: diagnosis.logTail ?? "",
      conflicts: diagnosis.conflicts ?? {},
      files: diagnosis.files ?? {},
    })),
    regenPi: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    commitPush: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => undefined),
  };
}

const ADDITIVE_CONFLICT = [
  "import { a } from './a.js';",
  "<<<<<<< HEAD",
  "import { b } from './b.js';",
  "=======",
  "import { c } from './c.js';",
  ">>>>>>> origin/main",
  "export const x = 1;",
].join("\n");

const SEMANTIC_CONFLICT = [
  "<<<<<<< HEAD",
  "const retries = computeRetries(env, 3);",
  "=======",
  "const retries = legacyRetries(env);",
  ">>>>>>> origin/main",
].join("\n");

describe("union conflict resolver", () => {
  it("unions an import-block conflict ours-then-theirs", () => {
    expect(unionResolveConflicts(ADDITIVE_CONFLICT)).toBe(
      [
        "import { a } from './a.js';",
        "import { b } from './b.js';",
        "import { c } from './c.js';",
        "export const x = 1;",
      ].join("\n"),
    );
  });

  it("refuses an overlapping-edit conflict (same key rewritten on both sides)", () => {
    expect(unionResolveConflicts(SEMANTIC_CONFLICT)).toBeNull();
  });

  it("refuses a conflict with a non-empty base section (both sides edited)", () => {
    const withBase = [
      "<<<<<<< HEAD",
      '"one",',
      "|||||||",
      '"orig",',
      "=======",
      '"two",',
      ">>>>>>> origin/main",
    ].join("\n");
    expect(unionResolveConflicts(withBase)).toBeNull();
  });
});

describe("classification + rename registry", () => {
  it("classifies the 2026-07-22 classes", () => {
    expect(
      classifyMedicFailure({ logTail: "error: packaging/pi/<name>/ staged Pi packages are stale; run pnpm pi:packages:build", conflicts: {}, files: {} }),
    ).toBe("stale-pi");
    expect(
      classifyMedicFailure({ logTail: "", conflicts: {}, files: { "a.ts": "createDevAfkMcpDependencies(cwd)" } }),
    ).toBe("stale-rename");
    expect(
      classifyMedicFailure({ logTail: "", conflicts: { "a.ts": ADDITIVE_CONFLICT }, files: {} }),
    ).toBe("additive-conflict");
    expect(
      classifyMedicFailure({ logTail: "1 failed", conflicts: { "a.ts": SEMANTIC_CONFLICT }, files: {} }),
    ).toBe("semantic");
  });

  it("applies the registered rename with a count", () => {
    const healed = applyRenameRegistry("const deps = createDevAfkMcpDependencies(cwd);");
    expect(healed.text).toBe("const deps = createCastleMcpDependencies(cwd);");
    expect(healed.replacements).toBe(1);
  });
});

describe("bounded medic pass (#2513)", () => {
  it("stale Pi mirrors heal to a push without escalation", async () => {
    const store = memoryStore();
    const io = makeIo({ logTail: "staged Pi packages are stale" });

    const result = await runMedicPass(io, store, 90, { nowEpoch: NOW });

    expect(result.outcome).toBe("healed");
    expect(result.clazz).toBe("stale-pi");
    expect(io.regenPi).toHaveBeenCalledTimes(1);
    expect(io.regenPi).toHaveBeenCalledWith(90);
    expect(io.commitPush).toHaveBeenCalledTimes(1);
    expect(io.cleanup).toHaveBeenCalledTimes(1);
    expect(store.value.prs["90"]!.outcome).toBe("healed");
  });

  it("a file referencing a registered old identifier is renamed and committed", async () => {
    const store = memoryStore();
    const io = makeIo({ files: { "src/x.ts": "createDevAfkMcpDependencies(cwd);" } });

    const result = await runMedicPass(io, store, 91, { nowEpoch: NOW });

    expect(result.outcome).toBe("healed");
    expect(result.clazz).toBe("stale-rename");
    expect(io.writeFile).toHaveBeenCalledWith(91, "src/x.ts", "createCastleMcpDependencies(cwd);");
    expect(io.commitPush).toHaveBeenCalledTimes(1);
  });

  it("a non-additive conflict escalates untouched and the worktree is cleaned", async () => {
    const store = memoryStore();
    const io = makeIo({ conflicts: { "src/y.ts": SEMANTIC_CONFLICT } });

    const result = await runMedicPass(io, store, 92, { nowEpoch: NOW });

    expect(result.outcome).toBe("escalated");
    expect(io.writeFile).not.toHaveBeenCalled();
    expect(io.commitPush).not.toHaveBeenCalled();
    expect(io.cleanup).toHaveBeenCalledTimes(1);
    expect(store.value.prs["92"]!.outcome).toBe("escalated");
  });

  it("healing rounds are bounded at MEDIC_MAX_ROUNDS and every action is ledgered", async () => {
    const store = memoryStore({
      version: 1,
      prs: {
        "93": { pr: 93, rounds: MEDIC_MAX_ROUNDS, outcome: "healing", updatedAtEpoch: NOW, actions: ["round 1", "round 2"] },
      },
    });
    const io = makeIo({ logTail: "staged Pi packages are stale" });

    const result = await runMedicPass(io, store, 93, { nowEpoch: NOW + 1 });

    expect(result.outcome).toBe("exhausted");
    expect(io.diagnose).not.toHaveBeenCalled();
    expect(io.commitPush).not.toHaveBeenCalled();
    const record = store.value.prs["93"]!;
    expect(record.outcome).toBe("escalated");
    expect(record.rounds).toBe(MEDIC_MAX_ROUNDS + 1);
    expect(record.actions.some((a) => a.includes("escalating"))).toBe(true);
  });
});
