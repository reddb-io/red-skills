import { describe, expect, it } from "vitest";
import {
  genWorkerId,
  matchesSelector,
  runModeForCandidate,
  slugify,
  type IssueCandidate,
} from "../src/core/session.js";

// ---------- candidate builder ----------

function cand(number: number, labels: string[] = ["ready-for-agent"], over: Partial<IssueCandidate> = {}): IssueCandidate {
  return { number, title: `issue ${number}`, body: "", labels, ...over };
}

// ---------- runModeForCandidate ----------

describe("runModeForCandidate (type:scout fleet routing)", () => {
  it("returns undefined for a plain ship candidate (no type:scout label)", () => {
    expect(runModeForCandidate(cand(1, ["ready-for-agent"]))).toBeUndefined();
    expect(runModeForCandidate(cand(2, ["ready-for-agent", "priority:high"]))).toBeUndefined();
  });

  it("returns 'scout' when the candidate carries the type:scout label", () => {
    expect(runModeForCandidate(cand(3, ["ready-for-agent", "type:scout"]))).toBe("scout");
  });

  it("the --run-mode flag takes priority over the label", () => {
    expect(runModeForCandidate(cand(4, ["ready-for-agent", "type:scout"]), "scout")).toBe("scout");
    expect(runModeForCandidate(cand(5, ["ready-for-agent"]), "scout")).toBe("scout");
  });

});

// ---------- matchesSelector (parity with castle matchesWorkSelector) ----------

describe("matchesSelector territory facets (kept in sync with the castle copy)", () => {
  it("ANDs every requested tag and excludes untagged candidates outright", () => {
    const both = cand(1, ["ready-for-agent", "tag:backend", "tag:infra"]);
    expect(matchesSelector(both, { tags: ["backend", "infra"] })).toBe(true);
    expect(matchesSelector(cand(2, ["ready-for-agent", "tag:backend"]), { tags: ["backend", "infra"] })).toBe(false);
    expect(matchesSelector(cand(3), { tags: ["backend"] })).toBe(false);
  });

  it("matches the user facet against the author case-insensitively and never without one", () => {
    expect(matchesSelector(cand(1, undefined, { author: "OctoCat" }), { user: "octocat" })).toBe(true);
    expect(matchesSelector(cand(2, undefined, { author: "octocat" }), { user: "someone" })).toBe(false);
    expect(matchesSelector(cand(3), { user: "octocat" })).toBe(false);
  });
});

// ---------- slugify ----------

describe("slugify", () => {
  it("lowercases, collapses to dashes, trims, and caps at 40", () => {
    expect(slugify("Fix the Thing!")).toBe("fix-the-thing");
    expect(slugify("  Wire OAuth  ")).toBe("wire-oauth");
  });
});

// ---------- genWorkerId ----------

describe("genWorkerId", () => {
  it("returns `w` + 4 chars drawn from [A-Z0-9]", () => {
    let i = 0;
    const seq = [0, 0, 0, 0]; // → AAAA
    const id = genWorkerId(() => seq[i++ % seq.length]!);
    expect(id).toBe("wAAAA");
    expect(id).toMatch(/^w[A-Z0-9]{4}$/);
  });

  it("draws across the full alphabet deterministically", () => {
    // 36-char alphabet; 35/36 → 'Z' (index 25 is 'Z'? alphabet = A..Z0..9).
    const vals = [25 / 36, 26 / 36, 35 / 36, 0]; // Z, 0, 9, A
    let i = 0;
    expect(genWorkerId(() => vals[i++]!)).toBe("wZ09A");
  });

  it("retries on a collision until `exists` returns false", () => {
    // First candidate (AAAA) collides; second (BAAA) is free.
    let call = 0;
    const rand = () => {
      // 8 draws total: AAAA then BAAA.
      const draws = [0, 0, 0, 0, 1 / 36, 0, 0, 0];
      return draws[call++]!;
    };
    const exists = (id: string) => id === "wAAAA";
    expect(genWorkerId(rand, exists)).toBe("wBAAA");
  });
});
