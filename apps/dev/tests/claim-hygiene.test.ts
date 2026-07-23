import { describe, expect, it, vi } from "vitest";
import {
  applyClaimHygieneFix,
  autoHealableClaimHygiene,
  runClaimHygieneProbe,
} from "../src/core/operational-probes/claim-hygiene.js";
import type { OperationalProbeResult } from "../src/core/operational-probes.js";

describe("claim hygiene operational probe", () => {
  it("gates concede for dead own workers, preserves live claims, and reports foreign namespaces", async () => {
    const deadClaim = "<!-- afk:claim v1 worker=8cb3eafdcbd2:wDead kind=claim runner=codex -->";
    const liveClaim = "<!-- afk:claim v1 worker=8cb3eafdcbd2:wLive kind=claim runner=codex -->";
    const foreignClaim = "<!-- stn:claim v1 worker=stone:wOther kind=claim runner=codex -->";
    const concededClaim = "<!-- afk:claim v1 worker=8cb3eafdcbd2:wGone kind=claim runner=codex -->";
    const concede = "<!-- afk:claim v1 worker=8cb3eafdcbd2:wGone kind=concede runner=codex -->";
    const result = await runClaimHygieneProbe({
      remoteUrls: [],
      claimHygiene: {
        ownWorkerPrefix: "8cb3eafdcbd2:",
        listOpenQueueIssues: async () => [
          {
            number: 1970,
            comments: [
              { id: 10, body: deadClaim, createdAt: "2026-07-17T10:00:00Z" },
              { id: 11, body: liveClaim, createdAt: "2026-07-17T10:01:00Z" },
              { id: 12, body: foreignClaim, createdAt: "2026-07-17T10:02:00Z" },
              { id: 13, body: concededClaim, createdAt: "2026-07-17T10:03:00Z" },
              { id: 14, body: concede, createdAt: "2026-07-17T10:04:00Z" },
            ],
          },
        ],
        workerPidState: (worker) => {
          if (worker.endsWith(":wDead")) return "dead";
          if (worker.endsWith(":wLive")) return "live";
          return "foreign";
        },
      },
    });

    expect(result).toMatchObject({
      id: "afk.claim-hygiene",
      verdict: "red",
      fix: { gate: "confirm" },
    });
    expect(result.evidence).toContain("issue=#1970");
    expect(result.evidence).toContain("worker=8cb3eafdcbd2:wDead");
    expect(result.evidence).toContain("pid=dead");
    expect(result.evidence).toContain("foreign_namespace=stn");
    expect(result.evidence).toContain("live_own=1");
    expect(result.evidence).not.toContain("wGone");

    const confirm = vi.fn(async (_finding: OperationalProbeResult) => true);
    const concedeClaim = vi.fn(async (_issue: number, _body: string) => {});
    const fix = await applyClaimHygieneFix(result, { confirm, concedeClaim });

    expect(fix).toEqual({
      probeId: "afk.claim-hygiene",
      status: "applied",
      evidence: "posted 1 concede marker",
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0].evidence).toContain("marker_comment=10");
    expect(concedeClaim).toHaveBeenCalledOnce();
    expect(concedeClaim.mock.calls[0]?.[0]).toBe(1970);
    expect(concedeClaim.mock.calls[0]?.[1]).toContain(
      "<!-- afk:claim v1 worker=8cb3eafdcbd2:wDead kind=concede runner=codex -->",
    );
  });

  it("does not mutate foreign namespace-only findings", async () => {
    const result = await runClaimHygieneProbe({
      remoteUrls: [],
      claimHygiene: {
        ownWorkerPrefix: "8cb3eafdcbd2:",
        listOpenQueueIssues: async () => [
          {
            number: 2000,
            comments: [
              {
                id: 20,
                body: "<!-- stn:claim v1 worker=stone:wOther kind=claim runner=codex -->",
                createdAt: "2026-07-17T10:00:00Z",
              },
            ],
          },
        ],
        workerPidState: () => "foreign",
      },
    });
    const concedeClaim = vi.fn(async (_issue: number, _body: string) => {});
    const fix = await applyClaimHygieneFix(result, {
      confirm: async () => true,
      concedeClaim,
    });

    expect(result.verdict).toBe("red");
    expect(result.fix).toBeUndefined();
    expect(result.evidence).toContain("foreign_namespace=stn");
    expect(fix).toEqual({
      probeId: "afk.claim-hygiene",
      status: "noop",
      evidence: "no dead own-namespace dangling claims need repair",
    });
    expect(concedeClaim).not.toHaveBeenCalled();
  });
});

describe("autoHealableClaimHygiene (boot self-heal gate, #2321)", () => {
  const deadOwn = "<!-- afk:claim v1 worker=8cb3eafdcbd2:wDead kind=claim runner=claude -->";
  const foreign = "<!-- stn:claim v1 worker=stone:wOther kind=claim runner=codex -->";
  const unknownOwn = "<!-- afk:claim v1 worker=8cb3eafdcbd2:wHuh kind=claim runner=claude -->";

  async function probe(
    comments: { id: number; body: string; createdAt: string }[],
    pidState: (worker: string) => "dead" | "live" | "unknown" | "foreign",
  ) {
    return runClaimHygieneProbe({
      remoteUrls: [],
      claimHygiene: {
        ownWorkerPrefix: "8cb3eafdcbd2:",
        listOpenQueueIssues: async () => [{ number: 2223, comments }],
        workerPidState: pidState,
      },
    });
  }

  it("returns the data when the ONLY finding is dead own-machine danglers (boot may auto-concede)", async () => {
    const result = await probe(
      [{ id: 1, body: deadOwn, createdAt: "2026-07-21T10:00:00Z" }],
      (worker) => (worker.endsWith(":wDead") ? "dead" : "unknown"),
    );
    const data = autoHealableClaimHygiene(result);
    expect(data).not.toBeNull();
    expect(data?.actions).toHaveLength(1);
    expect(data?.foreign).toHaveLength(0);
    expect(data?.unknownOwn).toBe(0);
  });

  it("returns null when a foreign-namespace dangler is present (needs a human — boot must still halt)", async () => {
    const result = await probe(
      [
        { id: 1, body: deadOwn, createdAt: "2026-07-21T10:00:00Z" },
        { id: 2, body: foreign, createdAt: "2026-07-21T10:01:00Z" },
      ],
      (worker) => (worker.endsWith(":wDead") ? "dead" : "foreign"),
    );
    expect(autoHealableClaimHygiene(result)).toBeNull();
  });

  it("returns null when an own dangler has an unknown (not-provably-dead) pid alongside a dead one", async () => {
    const result = await probe(
      [
        { id: 1, body: deadOwn, createdAt: "2026-07-21T10:00:00Z" },
        { id: 2, body: unknownOwn, createdAt: "2026-07-21T10:01:00Z" },
      ],
      (worker) => (worker.endsWith(":wDead") ? "dead" : "unknown"),
    );
    expect(autoHealableClaimHygiene(result)).toBeNull();
  });
});

describe("claim TTL on unknown-pid markers (#2525)", () => {
  const base = {
    remoteUrls: [],
  };
  const mk = (nowS?: number) => ({
    ...base,
    claimHygiene: {
      ownWorkerPrefix: "8cb3eafdcbd2:",
      ...(nowS !== undefined ? { nowS } : {}),
      listOpenQueueIssues: async () => [
        {
          number: 2525,
          comments: [
            {
              id: 30,
              body: "<!-- afk:claim v1 worker=8cb3eafdcbd2:wGhost kind=claim runner=codex ts=2026-07-22T00:00:00Z -->",
              createdAt: "2026-07-22T00:00:00Z",
            },
          ],
        },
      ],
      workerPidState: () => "unknown" as const,
    },
  });

  it("treats an unknown-pid marker aged past the TTL window as a concedable expired action", async () => {
    // 2026-07-22T00:00:00Z + 2h — far past the default 1080s stale window.
    const nowS = Math.floor(Date.parse("2026-07-22T02:00:00Z") / 1000);
    const result = await runClaimHygieneProbe(mk(nowS));
    expect(result.verdict).toBe("red");
    expect(result.evidence).toContain("pid=expired");
    expect(autoHealableClaimHygiene(result)).not.toBeNull();
  });

  it("keeps a fresh unknown-pid marker as human-adjudicated (not auto-healable)", async () => {
    // 60s after the marker: within grace + window.
    const nowS = Math.floor(Date.parse("2026-07-22T00:01:00Z") / 1000);
    const result = await runClaimHygieneProbe(mk(nowS));
    expect(result.verdict).toBe("red");
    expect(result.evidence).not.toContain("pid=expired");
    expect(autoHealableClaimHygiene(result)).toBeNull();
  });

  it("without an injected clock the TTL check is skipped entirely", async () => {
    const result = await runClaimHygieneProbe(mk(undefined));
    expect(result.evidence).not.toContain("pid=expired");
    expect(autoHealableClaimHygiene(result)).toBeNull();
  });
});
