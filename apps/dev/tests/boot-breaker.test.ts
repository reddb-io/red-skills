// boot-breaker.test.ts — crashloop circuit breaker (#2527, ADR 0122 amendment).
//
// N consecutive identical boot-death signatures trip the breaker: the
// supervisor stops feeding the respawn loop, the resident healer is invoked
// immediately, and a loud alert record is emitted. A different signature or one
// successful boot resets the run; the boot probe refuses to proceed while the
// breaker is open.

import { describe, expect, it } from "vitest";
import {
  BOOT_BREAKER_DEFAULT_THRESHOLD,
  bootDeathSignature,
  isBreakerOpen,
  recordBootDeath,
} from "../src/core/supervisor/boot-breaker.js";
import { BootHaltError } from "../src/core/boot.js";

const NOW = 1_000_000;

function probeHalt(evidence: string): BootHaltError {
  return new BootHaltError("operational-probe", {
    id: "claim-hygiene",
    name: "Claim hygiene",
    verdict: "red",
    evidence,
    canonicalFix: "release the ghost claim",
  });
}

describe("recordBootDeath — pure consecutive-signature breaker", () => {
  it("trips exactly on the Nth consecutive identical signature, not before, not again", () => {
    const sig = "operational-probe|claim-hygiene|#2521 marker w8DI1";
    const first = recordBootDeath(null, sig, NOW);
    expect(first.tripped).toBe(false);
    expect(first.ledger.count).toBe(1);
    const second = recordBootDeath(first.ledger, sig, NOW + 10);
    expect(second.tripped).toBe(false);
    const third = recordBootDeath(second.ledger, sig, NOW + 20);
    expect(third.tripped).toBe(true);
    expect(third.ledger.count).toBe(BOOT_BREAKER_DEFAULT_THRESHOLD);
    expect(third.ledger.trippedAtEpoch).toBe(NOW + 20);
    // A 4th identical death keeps counting but must not re-fire the trip
    // (healer + alert already ran).
    const fourth = recordBootDeath(third.ledger, sig, NOW + 30);
    expect(fourth.tripped).toBe(false);
    expect(fourth.ledger.count).toBe(4);
    expect(isBreakerOpen(fourth.ledger)).toBe(true);
  });

  it("a different signature resets the consecutive run", () => {
    const a = recordBootDeath(null, "sig-A", NOW);
    const b = recordBootDeath(a.ledger, "sig-A", NOW + 1);
    const c = recordBootDeath(b.ledger, "sig-B", NOW + 2);
    expect(c.ledger.count).toBe(1);
    expect(c.tripped).toBe(false);
    expect(isBreakerOpen(c.ledger)).toBe(false);
  });

  it("bootDeathSignature is byte-identical for identical probe deaths and differs across refs", () => {
    const one = bootDeathSignature(probeHalt("#2521 held by dead marker w8DI1"));
    const two = bootDeathSignature(probeHalt("#2521 held by dead marker w8DI1"));
    const other = bootDeathSignature(probeHalt("#2174 held by dead marker wPB6V"));
    expect(one).toBe(two);
    expect(one).not.toBe(other);
  });
});
