import type { HealLedgerState, HealLedgerStore } from "@reddb-io/worker/engine";
import { describe, expect, it, vi } from "vitest";
import { makeDeps, options, runBoot } from "./boot.helpers.js";

const DEAD_CLAIM = "<!-- afk:claim v1 worker=local:wDead kind=claim runner=codex -->";

function memoryLedger(): HealLedgerStore & { value: HealLedgerState } {
  return {
    value: { version: 1, issues: {} },
    async read() {
      return this.value;
    },
    async write(value) {
      this.value = value;
    },
  };
}

describe("ADR 0122 boot heal budget", () => {
  it("quarantines the third heal in 24 hours instead of conceding again", async () => {
    const { deps } = makeDeps();
    const concedeClaim = vi.fn(async () => undefined);
    const editLabels = vi.fn(async () => undefined);
    const editBody = vi.fn(async (_issue: number, _body: string) => undefined);
    deps.concedeClaim = concedeClaim;
    deps.gh.editLabels = editLabels;
    Object.assign(deps.gh, {
      viewBody: async () => "Original body",
      editBody,
      viewLabels: async () => ["ready-for-agent"],
    });
    Object.assign(deps, { healLedger: memoryLedger() });
    const bootOptions = options({
      operationalProbes: {
        remoteUrls: [],
        claimHygiene: {
          ownWorkerPrefix: "local:",
          listOpenQueueIssues: async () => [
            {
              number: 333,
              comments: [{ id: 1, body: DEAD_CLAIM, createdAt: "2026-07-23T00:00:00Z" }],
            },
          ],
          workerPidState: () => "dead",
        },
      },
    });

    await runBoot(deps, bootOptions);
    await runBoot(deps, bootOptions);
    const third = await runBoot(deps, bootOptions);

    expect(concedeClaim).toHaveBeenCalledTimes(2);
    expect(editLabels).toHaveBeenCalledWith(333, ["ready-for-agent"], ["quarantine"]);
    expect(editBody).toHaveBeenCalledOnce();
    expect(editBody.mock.calls[0]?.[1]).toContain("<!-- afk:quarantine v1 issue=#333 -->");
    expect(editBody.mock.calls[0]?.[1]).toContain("3 heals within 24h");
    expect(third.quarantinedIssues).toEqual([333]);
  });

  it("quarantines a judgment-requiring claim defect without halting boot", async () => {
    const { deps } = makeDeps();
    const editLabels = vi.fn(async () => undefined);
    const editBody = vi.fn(async (_issue: number, _body: string) => undefined);
    deps.gh.editLabels = editLabels;
    Object.assign(deps.gh, {
      viewBody: async () => "Original body",
      editBody,
      viewLabels: async () => ["ready-for-agent"],
    });

    const result = await runBoot(
      deps,
      options({
        operationalProbes: {
          remoteUrls: [],
          claimHygiene: {
            ownWorkerPrefix: "local:",
            listOpenQueueIssues: async () => [
              {
                number: 444,
                comments: [
                  {
                    id: 9,
                    body: "<!-- stn:claim v1 worker=foreign:wOther kind=claim runner=codex -->",
                    createdAt: "2026-07-23T00:00:00Z",
                  },
                ],
              },
            ],
            workerPidState: () => "foreign",
          },
        },
      }),
    );

    expect(result.bootstrap).toEqual({ ok: true });
    expect(result.quarantinedIssues).toEqual([444]);
    expect(editLabels).toHaveBeenCalledWith(444, ["ready-for-agent"], ["quarantine"]);
    expect(editBody.mock.calls[0]?.[1]).toContain("kind: claim-hygiene");
  });

  it("locally excludes an own claim whose worker liveness is unknown", async () => {
    const { deps } = makeDeps();
    deps.gh.editLabels = vi.fn(async () => undefined);
    Object.assign(deps.gh, {
      viewBody: async () => "Original body",
      editBody: vi.fn(async () => undefined),
    });

    const result = await runBoot(
      deps,
      options({
        operationalProbes: {
          remoteUrls: [],
          claimHygiene: {
            ownWorkerPrefix: "local:",
            listOpenQueueIssues: async () => [
              {
                number: 445,
                comments: [
                  {
                    id: 10,
                    body: "<!-- afk:claim v1 worker=local:wMystery kind=claim runner=codex -->",
                    createdAt: "2026-07-23T00:00:00Z",
                  },
                ],
              },
            ],
            workerPidState: () => "unknown",
          },
        },
      }),
    );

    expect(result.bootstrap).toEqual({ ok: true });
    expect(result.quarantinedIssues).toEqual([445]);
  });
});
