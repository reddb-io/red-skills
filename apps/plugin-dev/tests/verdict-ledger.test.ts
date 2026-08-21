/**
 * The verdict ledger is an append-only history, not a store of the current
 * answer (ADR 0154). These tests pin the two halves that make it an audit
 * trail: a void SUPERSEDES the standing verdict, and it does so without
 * removing or editing a single earlier row.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LANE_RETENTION_REGISTRY } from "@reddb-io/shared/lane-retention.js";
import { CASTLE_STATE_MEMBERS } from "@reddb-io/shared/red-paths.js";
import {
  agentVerifierIdentity,
  createVerdictLedger,
  humanVerifierIdentity,
  standingVerdicts,
  VERDICT_LANE_ID,
  VERDICT_NAMES,
  VerdictLedgerError,
  verdictKeyOf,
  verdictLedgerPath,
  type VerdictLedger,
} from "../src/core/verdict-ledger.js";
import { laneCensusLaneIds } from "../src/core/operational-probes/lane-census.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const PATCH = "9".repeat(40);
const REVIEWER = agentVerifierIdentity("codex", "gpt-5");

const roots: string[] = [];

async function ledger(): Promise<VerdictLedger> {
  const root = await mkdtemp(join(tmpdir(), "verdict-ledger-"));
  roots.push(root);
  let tick = 0;
  return createVerdictLedger(root, {
    clock: () => new Date(Date.UTC(2026, 7, 21, 0, 0, tick++)).toISOString(),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("verdict ledger round trip", () => {
  it("appends, reads back, and stands the row it wrote", async () => {
    const lane = await ledger();
    const written = await lane.append({
      pr: 4131,
      head_sha: HEAD_A,
      patch_id: PATCH,
      verdict: "test-verified",
      verifier_identity: REVIEWER,
      evidence: "ci-run:1234",
    });

    expect(written).toMatchObject({
      pr: 4131,
      head_sha: HEAD_A,
      verdict: "test-verified",
      verifier_identity: REVIEWER,
      voided: false,
      evidence: "ci-run:1234",
      reason: null,
    });
    await expect(lane.read()).resolves.toEqual([written]);
    await expect(lane.standing({ pr: 4131, head_sha: HEAD_A, patch_id: PATCH }))
      .resolves.toEqual(written);
  });

  it("reads a lane that was never written as no verdicts", async () => {
    await expect((await ledger()).read()).resolves.toEqual([]);
  });

  it("supersedes by appending a voided row, never by mutating history", async () => {
    const lane = await ledger();
    const key = { pr: 4131, head_sha: HEAD_A, patch_id: PATCH };
    const passed = await lane.append({ ...key, verdict: "test-verified", verifier_identity: REVIEWER });
    const beforeVoid = await readFile(lane.path, "utf8");

    const voided = await lane.void({
      ...key,
      verdict: "test-verified",
      verifier_identity: REVIEWER,
      reason: "head moved after validation",
    });

    const after = await readFile(lane.path, "utf8");
    // The earlier bytes are a PREFIX of the later ones: nothing was rewritten.
    expect(after.startsWith(beforeVoid)).toBe(true);
    expect(voided.voided).toBe(true);

    const rows = await lane.read();
    expect(rows).toEqual([passed, voided]);
    await expect(lane.standing(key)).resolves.toBeNull();

    const standing = standingVerdicts(rows).get(verdictKeyOf(key));
    expect(standing?.standing).toBeNull();
    expect(standing?.voidedBy?.reason).toBe("head moved after validation");
    expect(standing?.history).toEqual([passed, voided]);
  });

  it("keys by head, so voiding one head leaves another head standing", async () => {
    const lane = await ledger();
    const stale = { pr: 4131, head_sha: HEAD_A, patch_id: PATCH };
    const fresh = { pr: 4131, head_sha: HEAD_B, patch_id: PATCH };
    await lane.append({ ...stale, verdict: "test-verified", verifier_identity: REVIEWER });
    const reviewed = await lane.append({
      ...fresh,
      verdict: "live-verified",
      verifier_identity: humanVerifierIdentity("filipeforattini"),
    });
    await lane.void({
      ...stale,
      verdict: "test-verified",
      verifier_identity: REVIEWER,
      reason: "superseded by the re-review at the fresh head",
    });

    await expect(lane.standing(stale)).resolves.toBeNull();
    await expect(lane.standing(fresh)).resolves.toEqual(reviewed);
    expect(reviewed.verifier_identity).toBe("human:filipeforattini");
    expect((await lane.read()).length).toBe(3);
  });

  it("re-verification after a void stands again without erasing the void", async () => {
    const lane = await ledger();
    const key = { pr: 4131, head_sha: HEAD_A, patch_id: PATCH };
    await lane.append({ ...key, verdict: "verifier-failed", verifier_identity: REVIEWER });
    await lane.void({
      ...key,
      verdict: "verifier-failed",
      verifier_identity: REVIEWER,
      reason: "re-reviewed after the fix",
    });
    const reVerified = await lane.append({
      ...key,
      verdict: "test-verified",
      verifier_identity: REVIEWER,
    });

    const rows = await lane.read();
    expect(rows.map((row) => row.verdict)).toEqual([
      "verifier-failed",
      "verifier-failed",
      "test-verified",
    ]);
    expect(rows.map((row) => row.voided)).toEqual([false, true, false]);
    await expect(lane.standing(key)).resolves.toEqual(reVerified);
  });
});

describe("verdict ledger refusals", () => {
  it("refuses a verdict outside the closed enum", async () => {
    const lane = await ledger();
    await expect(lane.append({
      pr: 1,
      head_sha: HEAD_A,
      patch_id: PATCH,
      verdict: "looks-fine" as never,
      verifier_identity: REVIEWER,
    })).rejects.toThrow(VerdictLedgerError);
  });

  it("refuses a head that is not a git object id", async () => {
    const lane = await ledger();
    await expect(lane.append({
      pr: 1,
      head_sha: "HEAD",
      patch_id: PATCH,
      verdict: "test-verified",
      verifier_identity: REVIEWER,
    })).rejects.toThrow(/head_sha/);
  });

  it("refuses a row with no verifier identity", async () => {
    const lane = await ledger();
    await expect(lane.append({
      pr: 1,
      head_sha: HEAD_A,
      patch_id: PATCH,
      verdict: "test-verified",
      verifier_identity: "  ",
    })).rejects.toThrow(/verifier_identity/);
  });

  it("refuses a void with no reason, because an unexplained void is a mutation", async () => {
    const lane = await ledger();
    await expect(lane.void({
      pr: 1,
      head_sha: HEAD_A,
      patch_id: PATCH,
      verdict: "test-verified",
      verifier_identity: REVIEWER,
      reason: "",
    })).rejects.toThrow(/reason/);
  });

  it("names both halves of an agent identity", () => {
    expect(agentVerifierIdentity("claude", "opus")).toBe("claude:opus");
    expect(() => agentVerifierIdentity("claude", " ")).toThrow(VerdictLedgerError);
    expect(() => humanVerifierIdentity("")).toThrow(VerdictLedgerError);
  });
});

describe("verdict lane registration", () => {
  it("writes TOONL into the durable castle state tier", async () => {
    const lane = await ledger();
    expect(lane.path.endsWith(join(".red", "state", "castle", "verdicts.toonl"))).toBe(true);
    expect(verdictLedgerPath("/project")).toBe(
      join("/project", ".red", "state", "castle", "verdicts.toonl"),
    );

    await lane.append({
      pr: 4131,
      head_sha: HEAD_A,
      patch_id: PATCH,
      verdict: "test-verified",
      verifier_identity: REVIEWER,
    });
    const text = await readFile(lane.path, "utf8");
    expect(text.split("\n")[0]).toMatch(
      /^\[\d*\]\{at,pr,head_sha,patch_id,verdict,verifier_identity,voided,evidence,reason\}:$/,
    );
    expect(text.trimStart().startsWith("{")).toBe(false);
  });

  it("is registered, censused, and bounded by its registry entry", () => {
    expect(Object.keys(LANE_RETENTION_REGISTRY)).toContain(VERDICT_LANE_ID);
    expect(LANE_RETENTION_REGISTRY[VERDICT_LANE_ID].maxBytes).toBeGreaterThan(0);
    expect(laneCensusLaneIds()).toContain(VERDICT_LANE_ID);
    expect(Object.keys(CASTLE_STATE_MEMBERS)).toContain("verdicts.toonl");
  });

  it("trims to the registered ceiling instead of growing past it", async () => {
    const root = await mkdtemp(join(tmpdir(), "verdict-ledger-ceiling-"));
    roots.push(root);
    const lane = createVerdictLedger(root, { maxBytes: 900 });
    for (let index = 0; index < 40; index += 1) {
      await lane.append({
        pr: 4131,
        head_sha: HEAD_A,
        patch_id: PATCH,
        verdict: "test-verified",
        verifier_identity: REVIEWER,
        reason: `pass ${index}`,
      });
    }
    const text = await readFile(lane.path, "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(900);
    const rows = await lane.read();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)?.reason).toBe("pass 39");
  });

  it("closes the verdict vocabulary at exactly the five ADR 0154 outcomes", () => {
    expect([...VERDICT_NAMES]).toEqual([
      "live-verified",
      "test-verified",
      "type-check-only",
      "verifier-blocked",
      "verifier-failed",
    ]);
  });
});
