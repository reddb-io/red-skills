import { describe, expect, it } from "vitest";
import { parseUnitExitFacts } from "../src/reattach.js";

describe("systemd unit exit facts", () => {
  it("decodes a collected unit's MemoryMax kill from its journal tail", () => {
    const journal = [
      "Main process exited, code=killed, status=9/KILL",
      "Failed with result 'oom-kill'.",
      "Consumed 58min 2.001s CPU time, 2.5G memory peak, 3.0G memory swap peak.",
    ].join("\n");
    const facts = parseUnitExitFacts("", journal);

    expect(facts).toEqual({
      systemd_result: "oom-kill",
      exit_code: null,
      signal: "SIGKILL",
      memory_peak_bytes: 2_684_354_560,
      memory_swap_peak_bytes: 3_221_225_472,
      journal_tail: journal,
    });
  });
});
