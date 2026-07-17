import { describe, expect, it, vi } from "vitest";
import {
  applyClaimHygieneFix,
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
