import { describe, expect, it } from "vitest";
import { buildEnvelope } from "../src/core/envelope.js";

describe("envelope builder", () => {
  it("renders the deterministic details shape used in issue comments", () => {
    const envelope = buildEnvelope({
      status: "done",
      worker: "wZ2R4",
      duration: "2m5s",
      diff: "merged",
      attempt: 1,
      mergeSha: "abc1234",
      sections: [{ name: "validation", body: "tests: pass" }],
    });
    expect(envelope).toContain('<details data-attempt-status="done">');
    expect(envelope).toContain("worker `wZ2R4` · status: done · duration: 2m5s · diff: merged · attempt: 1 · merge: abc1234");
    expect(envelope).toContain('<details data-section="validation"><summary>validation</summary>');
  });

  it("escapes section names in HTML attributes/summaries", () => {
    const envelope = buildEnvelope({ status: "blocked", worker: "w", duration: "1s", diff: "+1 -0", attempt: 1, sections: [{ name: "x<y", body: "ok" }] });
    expect(envelope).toContain('data-section="x&lt;y"');
  });
});
