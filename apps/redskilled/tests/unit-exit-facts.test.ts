import { describe, expect, it } from "vitest";
import { parseUnitExitFacts } from "../src/reattach.js";

describe("systemd unit exit facts", () => {
  it("decodes a MemoryMax kill without turning the signal into exit 255", () => {
    const facts = parseUnitExitFacts([
      "Result=oom-kill",
      "ExecMainCode=2",
      "ExecMainStatus=9",
      "MemoryPeak=2684354560",
      "MemorySwapPeak=3221225472",
      "",
    ].join("\n"));

    expect(facts).toEqual({
      systemd_result: "oom-kill",
      exit_code: null,
      signal: "SIGKILL",
      memory_peak_bytes: 2_684_354_560,
      memory_swap_peak_bytes: 3_221_225_472,
    });
  });
});
