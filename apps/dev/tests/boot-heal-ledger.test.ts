import type { HealLedgerState, HealLedgerStore } from "@reddb-io/red-castle/engine";
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
    const editBody = vi.fn(async () => undefined);
    deps.concedeClaim = concedeClaim;
    deps.gh.editLabels = editLabels;
    Object.assign(deps.gh, {
      viewBody: async () => "Original body",
      editBody,
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
});
