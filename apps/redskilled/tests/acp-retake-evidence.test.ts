import { describe, expect, it } from "vitest";
import { isAcpRetakePrompt, renderAcpRetakeEvidence } from "../src/acp-retake-evidence.js";

describe("authorized ACP /retake evidence", () => {
  it("recognizes only the explicit operator command", () => {
    expect(isAcpRetakePrompt([{ type: "text", text: "/retake" }])).toBe(true);
    expect(isAcpRetakePrompt([{ type: "text", text: "tell me about retake" }])).toBe(false);
  });

  it("labels provider references as subordinate evidence", () => {
    expect(renderAcpRetakeEvidence({
      version: 1,
      public_session_id: "public-session",
      evidence: [
        {
          worker_id: "w3834",
          provider: "fixture-runner",
          reference: "provider-session:opaque",
          availability: "inaccessible",
          retention: "evidence",
        },
        {
          worker_id: "w3835",
          provider: "fixture-runner",
          availability: "absent",
          retention: "evidence",
        },
      ],
    })).toBe([
      "Subordinate provider session evidence (the redskilled journal remains session truth):",
      "- provider-session:opaque — fixture-runner, inaccessible, retained as evidence",
      "- fixture-runner reported no provider artifact",
      "",
    ].join("\n"));
  });
});
