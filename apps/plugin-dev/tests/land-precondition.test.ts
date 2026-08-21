/**
 * The land precondition of ADR 0154 (Ticket #4138, Spec #4129): nothing merges
 * that no non-implementer identity judged AT THE HEAD BEING MERGED.
 *
 * Two suites, and the split is the Spec's. The refusal matrix proves the rule
 * itself — no row, a voided row, a row judging another head, a verifier that
 * refused, a verifier that could not conclude — against a pure decision with no
 * filesystem in sight. The integration suite then walks the exact sequence the
 * Spec asks for against a REAL on-disk ledger: publish at SHA A, the branch
 * advances to B, the land refuses, the stale row is voided, B is re-reviewed,
 * and the land succeeds. A rule proven only in the pure layer is a rule nobody
 * has watched supersede anything.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LAND_PASSING_COUNTERSIGNS,
  createLedgerLandCountersignGate,
  decideLandCountersign,
  isPassingCountersign,
  landHeadPrecondition,
  recordAdoptionCountersign,
  recordHumanAdoptionCountersign,
} from "../src/core/land-precondition.js";
import {
  COUNTERSIGN_CLASSES,
  createCountersignLedger,
  normalizeCountersignRow,
  type CountersignKey,
  type CountersignLedger,
  type CountersignRow,
} from "../src/core/countersign-ledger.js";
import type { LandSubject } from "@reddb-io/shared/land-countersign.js";

const PR = 4138;
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const PATCH_A = "1".repeat(40);
const PATCH_B = "2".repeat(40);
const VERIFIER = "codex:gpt-5";

const KEY_A: CountersignKey = { pr: PR, head_sha: HEAD_A, patch_id: PATCH_A };
const KEY_B: CountersignKey = { pr: PR, head_sha: HEAD_B, patch_id: PATCH_B };

function row(over: Partial<CountersignRow> & { head_sha: string }): CountersignRow {
  return normalizeCountersignRow({
    at: "2026-08-21T00:00:00.000Z",
    pr: PR,
    patch_id: PATCH_A,
    countersign: "test-verified",
    verifier_identity: VERIFIER,
    voided: false,
    evidence: null,
    reason: null,
    ...over,
  });
}

describe("the refusal matrix (#4138)", () => {
  it("names exactly the Countersign classes that authorize a merge — never the two that mean 'not approved'", () => {
    expect([...LAND_PASSING_COUNTERSIGNS]).toEqual([
      "live-verified",
      "test-verified",
      "type-check-only",
    ]);
    for (const countersign of COUNTERSIGN_CLASSES) {
      expect(isPassingCountersign(countersign)).toBe(
        countersign !== "verifier-failed" && countersign !== "verifier-blocked",
      );
    }
  });

  it("refuses when the ledger holds no row at all", () => {
    const judged = decideLandCountersign([], KEY_A);
    expect(judged.decision.allowed).toBe(false);
    if (judged.decision.allowed) return;
    expect(judged.decision.reason).toBe("no-countersign");
    expect(judged.decision.message).toContain(HEAD_A.slice(0, 12));
    expect(judged.supersede).toBeNull();
  });

  it("refuses a voided row — a superseded judgement authorizes nothing", () => {
    const rows = [
      row({ head_sha: HEAD_A }),
      row({ head_sha: HEAD_A, voided: true, reason: "re-review requested" }),
    ];
    const judged = decideLandCountersign(rows, KEY_A);
    expect(judged.decision.allowed).toBe(false);
    if (judged.decision.allowed) return;
    expect(judged.decision.reason).toBe("voided-countersign");
    expect(judged.decision.message).toContain("re-review requested");
  });

  it("refuses a row that judged another head, and names the row to supersede", () => {
    const judged = decideLandCountersign([row({ head_sha: HEAD_A })], KEY_B);
    expect(judged.decision.allowed).toBe(false);
    if (judged.decision.allowed) return;
    expect(judged.decision.reason).toBe("stale-countersign");
    expect(judged.decision.message).toContain(HEAD_A.slice(0, 12));
    expect(judged.supersede?.head_sha).toBe(HEAD_A);
  });

  it("refuses a verifier-failed row under its OWN name — a refusal is not an absence", () => {
    const rows = [row({ head_sha: HEAD_A, countersign: "verifier-failed", reason: "the fix is untested" })];
    const judged = decideLandCountersign(rows, KEY_A);
    expect(judged.decision.allowed).toBe(false);
    if (judged.decision.allowed) return;
    expect(judged.decision.reason).toBe("verifier-failed");
    expect(judged.decision.message).toContain("the fix is untested");
  });

  it("refuses a verifier-blocked row and points at the runner, not the diff", () => {
    const rows = [row({ head_sha: HEAD_A, countersign: "verifier-blocked", reason: "reviewer runner unwired" })];
    const judged = decideLandCountersign(rows, KEY_A);
    expect(judged.decision.allowed).toBe(false);
    if (judged.decision.allowed) return;
    expect(judged.decision.reason).toBe("verifier-blocked");
    expect(judged.decision.message).toContain("advisory");
  });

  it("lands on a fresh passing row for the exact head", () => {
    const judged = decideLandCountersign([row({ head_sha: HEAD_A })], KEY_A);
    expect(judged.decision.allowed).toBe(true);
    if (!judged.decision.allowed) return;
    expect(judged.decision.matchedBy).toBe("head-sha");
    expect(judged.decision.identity).toBe(VERIFIER);
  });

  it("forgives ONE divergence: a clean rebase carrying the identical stable patch-id", () => {
    const rows = [row({ head_sha: HEAD_A, patch_id: PATCH_A })];
    const rebased: CountersignKey = { pr: PR, head_sha: HEAD_B, patch_id: PATCH_A };
    const judged = decideLandCountersign(rows, rebased);
    expect(judged.decision.allowed).toBe(true);
    if (!judged.decision.allowed) return;
    expect(judged.decision.matchedBy).toBe("patch-id");
    expect(judged.supersede).toBeNull();
  });

  it("never reads another pull request's judgement as this one's", () => {
    const other = row({ head_sha: HEAD_A });
    const judged = decideLandCountersign([{ ...other, pr: PR + 1 }], KEY_A);
    expect(judged.decision.allowed).toBe(false);
    if (judged.decision.allowed) return;
    expect(judged.decision.reason).toBe("no-countersign");
  });
});

describe("the ledger-backed gate (#4138)", () => {
  let root = "";
  let ledger: CountersignLedger;

  const open = async (): Promise<void> => {
    root = await mkdtemp(join(tmpdir(), "land-precondition-"));
    ledger = createCountersignLedger(root);
  };
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  const gateFor = (key: CountersignKey) =>
    createLedgerLandCountersignGate({ ledger, resolveKey: async () => key });

  it("refuses a subject whose key nobody could resolve", async () => {
    await open();
    const gate = createLedgerLandCountersignGate({ ledger, resolveKey: async () => null });
    const decision = await gate.check({ kind: "pull-request", pr: PR });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("unresolvable-head");
  });

  it("publish at A, advance to B: the land refuses, the row is voided, re-review lands", async () => {
    await open();

    // The verifier judged the published head A.
    await ledger.append({ ...KEY_A, countersign: "test-verified", verifier_identity: VERIFIER });
    const atA = await gateFor(KEY_A).check({ kind: "head", headSha: HEAD_A });
    expect(atA.allowed).toBe(true);

    // The branch advances to B with a different change; the land refuses.
    const atB = await gateFor(KEY_B).check({ kind: "head", headSha: HEAD_B });
    expect(atB.allowed).toBe(false);
    if (atB.allowed) return;
    expect(atB.reason).toBe("stale-countersign");

    // The refusal SUPERSEDED the stale row rather than leaving it standing.
    expect(await ledger.standing(KEY_A)).toBeNull();
    const rows = await ledger.read();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.voided).toBe(true);
    expect(rows[1]?.head_sha).toBe(HEAD_A);
    expect(rows[1]?.reason).toContain(HEAD_B.slice(0, 12));

    // A stale row that was already voided does not get voided a second time.
    const again = await gateFor(KEY_B).check({ kind: "head", headSha: HEAD_B });
    expect(again.allowed).toBe(false);
    expect(await ledger.read()).toHaveLength(2);

    // Re-review at B, and the same gate lands it.
    await ledger.append({ ...KEY_B, countersign: "test-verified", verifier_identity: VERIFIER });
    const relanded = await gateFor(KEY_B).check({ kind: "head", headSha: HEAD_B });
    expect(relanded.allowed).toBe(true);
    if (!relanded.allowed) return;
    expect(relanded.matchedBy).toBe("head-sha");
  });

  it("records the adopting human under their own login, never an exemption", async () => {
    await open();
    const written = await recordHumanAdoptionCountersign(ledger, { key: KEY_A, login: "filipeforattini" });
    expect(written.verifier_identity).toBe("human:filipeforattini");
    expect(written.countersign).toBe("live-verified");

    const decision = await gateFor(KEY_A).check({ kind: "head", headSha: HEAD_A });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.identity).toBe("human:filipeforattini");
  });

  it("signs nothing when no human adopted — an autonomous reconcile is not an adoption", async () => {
    await open();
    const exec = async () => ({ code: 1, stdout: "", stderr: "" });
    const deps = { ledger, gate: gateFor(KEY_A) };
    const base = { exec, repoDir: root, baseRef: "origin/main", tip: HEAD_A, pr: PR };

    expect(await recordAdoptionCountersign(deps, base)).toBeNull();
    expect(await recordAdoptionCountersign(undefined, { ...base, login: "someone" })).toBeNull();
    expect(await ledger.read()).toHaveLength(0);
  });

  it("pins an adoption row to the head alone when git cannot answer the patch id", async () => {
    await open();
    const exec = async () => ({ code: 1, stdout: "", stderr: "" });
    const written = await recordAdoptionCountersign(
      { ledger, gate: gateFor(KEY_A) },
      { exec, repoDir: root, baseRef: "origin/main", tip: HEAD_A, pr: PR, login: "maintainer" },
    );
    expect(written?.patch_id).toBe(`head:${HEAD_A}`);
  });
});

describe("landHeadPrecondition — one precondition, two questions (#4134 + #4138)", () => {
  const exec = async (args: string[]) =>
    args.includes("rev-parse")
      ? { code: 0, stdout: `${HEAD_A}\n`, stderr: "" }
      : { code: 1, stdout: "", stderr: "" };
  const input = { repoDir: "/repo", remote: "origin", branch: "afk/4138", base: "main" };

  it("asks nothing when no gate is wired, so an unarmed caller lands as before", async () => {
    expect(await landHeadPrecondition(exec, input)).toBeNull();
  });

  it("refuses `unverified-head` and carries the gate's own sentence", async () => {
    let asked: LandSubject | null = null;
    const refusal = await landHeadPrecondition(exec, input, {
      check: async (subject) => {
        asked = subject;
        return { allowed: false, reason: "no-countersign", message: "nobody judged it" };
      },
    });
    expect(refusal?.reason).toBe("unverified-head");
    expect(refusal?.message).toBe("nobody judged it");
    expect(asked).toEqual({ kind: "head", headSha: HEAD_A });
  });

  it("asks about the VALIDATED tip when the caller pinned one", async () => {
    const seen: string[] = [];
    await landHeadPrecondition(
      async (args: string[]) =>
        args.includes("rev-parse")
          ? { code: 0, stdout: `${HEAD_A}\n`, stderr: "" }
          : { code: 1, stdout: "", stderr: "" },
      { ...input, validatedBranchTip: HEAD_A },
      {
        check: async (subject) => {
          if (subject.kind === "head") seen.push(subject.headSha);
          return { allowed: true, matchedBy: "head-sha", countersign: "test-verified", identity: VERIFIER };
        },
      },
    );
    expect(seen).toEqual([HEAD_A]);
  });

  it("carries the Ticket's declared bar to the gate, and the fail-closed default when it declares none (#4174)", async () => {
    const asked: (string | null)[] = [];
    const gate = {
      check: async (_subject: LandSubject, requirement?: { label: string | null }) => {
        asked.push(requirement?.label ?? null);
        return { allowed: true, matchedBy: "head-sha", countersign: "test-verified", identity: VERIFIER } as const;
      },
    };
    await landHeadPrecondition(exec, { ...input, labels: ["ready-for-agent", "verify:live"] }, gate);
    await landHeadPrecondition(exec, { ...input, labels: ["ready-for-agent"] }, gate);
    await landHeadPrecondition(exec, input, gate);
    expect(asked).toEqual(["verify:live", null, null]);
  });

  it("refuses a land whose Countersign sits below the label's bar, end to end (#4174)", async () => {
    const root = await mkdtemp(join(tmpdir(), "verify-label-"));
    try {
      const ledger = createCountersignLedger(root);
      await ledger.append({ ...KEY_A, countersign: "test-verified", verifier_identity: VERIFIER });
      const gate = createLedgerLandCountersignGate({ ledger, resolveKey: async () => KEY_A });

      const refused = await landHeadPrecondition(exec, { ...input, labels: ["verify:live"] }, gate);
      expect(refused?.reason).toBe("unverified-head");
      expect(refused?.message).toContain("countersigned below the bar its Ticket declared");

      expect(await landHeadPrecondition(exec, { ...input, labels: ["verify:tests"] }, gate)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses when the head itself cannot be resolved — no head, no match, no merge", async () => {
    const refusal = await landHeadPrecondition(
      async () => ({ code: 1, stdout: "", stderr: "" }),
      input,
      { check: async () => ({ allowed: true, matchedBy: "head-sha", countersign: "x", identity: "y" }) },
    );
    expect(refusal?.reason).toBe("unverified-head");
    expect(refusal?.message).toContain("origin/afk/4138");
  });
});
