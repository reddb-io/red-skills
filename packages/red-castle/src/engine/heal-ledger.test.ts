import { describe, expect, it } from "vitest";
import {
  recordIssueHeal,
  type HealLedgerState,
  type HealLedgerStore,
} from "./heal-ledger.js";

function memoryStore(initial: HealLedgerState): HealLedgerStore & { value: HealLedgerState } {
  return {
    value: initial,
    async read() {
      return this.value;
    },
    async write(value) {
      this.value = value;
    },
  };
}

describe("castle issue heal ledger", () => {
  it("quarantines instead of authorizing the third heal within 24 hours", async () => {
    const hour = 60 * 60 * 1000;
    const now = Date.UTC(2026, 6, 23, 12);
    const store = memoryStore({
      version: 1,
      issues: { "42": [now - 2 * hour, now - hour] },
    });

    const decision = await recordIssueHeal(store, 42, now);

    expect(decision).toEqual({
      action: "quarantine",
      issue: 42,
      history: [now - 2 * hour, now - hour, now],
    });
    expect(store.value.issues["42"]).toEqual(decision.history);
  });

  it("prunes heals outside the rolling window before applying the budget", async () => {
    const now = Date.UTC(2026, 6, 23, 12);
    const store = memoryStore({
      version: 1,
      issues: { "42": [now - 25 * 60 * 60 * 1000, now - 1000] },
    });

    const decision = await recordIssueHeal(store, 42, now);

    expect(decision).toEqual({ action: "heal", issue: 42, history: [now - 1000, now] });
  });
});
