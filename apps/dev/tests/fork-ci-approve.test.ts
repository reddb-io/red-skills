import { describe, expect, it } from "vitest";
import {
  assessForkCiSafety,
  type ForkCiManifest,
} from "../src/core/fork-ci-approve.js";

const READONLY_RAW = [
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: pnpm install --frozen-lockfile && pnpm test",
].join("\n");

function manifest(overrides: Partial<ForkCiManifest> = {}): ForkCiManifest {
  return {
    raw: READONLY_RAW,
    permissions: { contents: "read" },
    permissionsDeclared: true,
    ...overrides,
  };
}

describe("assessForkCiSafety", () => {
  it("auto-approves a provably-safe run: no secrets.*, all permissions read-only", () => {
    const verdict = assessForkCiSafety(manifest());
    expect(verdict.decision).toBe("auto-approve");
    expect(verdict.reasons).toEqual([]);
  });

  it("auto-approves an explicitly-empty permissions block (all scopes revoked)", () => {
    const verdict = assessForkCiSafety(manifest({ permissions: {} }));
    expect(verdict.decision).toBe("auto-approve");
  });

  it("defers when any workflow job references secrets.* (dotted form)", () => {
    const raw = READONLY_RAW + "\n      - run: deploy --token ${{ secrets.DEPLOY_KEY }}";
    const verdict = assessForkCiSafety(manifest({ raw }));
    expect(verdict.decision).toBe("defer-to-human");
    expect(verdict.reasons.join(" ")).toMatch(/secrets/);
  });

  it("defers when secrets are referenced via the bracketed index form", () => {
    const raw = READONLY_RAW + "\n      - run: echo ${{ secrets['NPM_TOKEN'] }}";
    expect(assessForkCiSafety(manifest({ raw })).decision).toBe("defer-to-human");
  });

  it("treats secrets.GITHUB_TOKEN as disqualifying (provable, not plausible)", () => {
    const raw = READONLY_RAW + "\n      - run: gh api -H \"Authorization: ${{ secrets.GITHUB_TOKEN }}\"";
    expect(assessForkCiSafety(manifest({ raw })).decision).toBe("defer-to-human");
  });

  it("defers when any permission is write-scoped, naming the scopes", () => {
    const verdict = assessForkCiSafety(
      manifest({ permissions: { contents: "read", "pull-requests": "write", packages: "write" } }),
    );
    expect(verdict.decision).toBe("defer-to-human");
    // Scopes are reported sorted for a stable audit message.
    expect(verdict.reasons.join(" ")).toContain("packages, pull-requests");
  });

  it("defers when no permissions block was declared (GitHub default is not provably read-only)", () => {
    const verdict = assessForkCiSafety(manifest({ permissionsDeclared: false, permissions: {} }));
    expect(verdict.decision).toBe("defer-to-human");
    expect(verdict.reasons.join(" ")).toMatch(/default token scope/);
  });

  it("accumulates every failing reason rather than short-circuiting", () => {
    const raw = READONLY_RAW + "\n      - run: echo ${{ secrets.FOO }}";
    const verdict = assessForkCiSafety(
      manifest({ raw, permissions: { contents: "write" } }),
    );
    expect(verdict.decision).toBe("defer-to-human");
    expect(verdict.reasons).toHaveLength(2);
  });
});
