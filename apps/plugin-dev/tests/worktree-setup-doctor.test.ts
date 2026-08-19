import { describe, expect, it } from "vitest";
import { auditWorktreeSetup } from "../src/core/worktree-setup-doctor.js";

describe("auditWorktreeSetup (#3268)", () => {
  it("requires a declaration and names the detected package manager", () => {
    expect(
      auditWorktreeSetup({ declared: [], packageManager: "pnpm", hookManagers: [] }),
    ).toEqual({
      verdict: "error",
      findings: [
        {
          verdict: "error",
          reason:
            "plugins.dev.afk.setup is undeclared; /red-setup should confirm a pnpm worktree setup command",
        },
      ],
    });
  });

  it("accepts the matching package manager with the detected hook opt-out", () => {
    expect(
      auditWorktreeSetup({
        declared: ["LEFTHOOK=0 pnpm install --frozen-lockfile"],
        packageManager: "pnpm",
        hookManagers: ["lefthook"],
      }),
    ).toEqual({
      verdict: "ok",
      findings: [
        {
          command: "LEFTHOOK=0 pnpm install --frozen-lockfile",
          verdict: "ok",
          reason: "matches pnpm and disables lefthook during redirected-hooksPath setup",
        },
      ],
    });
  });

  it("rejects package-manager drift and an unsafe hook lifecycle", () => {
    expect(
      auditWorktreeSetup({
        declared: ["pnpm install --frozen-lockfile"],
        packageManager: "bun",
        hookManagers: ["husky"],
      }),
    ).toEqual({
      verdict: "error",
      findings: [
        {
          command: "pnpm install --frozen-lockfile",
          verdict: "error",
          reason:
            "repository uses bun, but the setup declaration does not; husky is detected but setup declares neither HUSKY=0 nor --ignore-scripts",
        },
      ],
    });
  });

  it("accepts --ignore-scripts as the explicit all-manager lifecycle opt-out", () => {
    expect(
      auditWorktreeSetup({
        declared: ["pnpm install --frozen-lockfile --ignore-scripts"],
        packageManager: "pnpm",
        hookManagers: ["husky", "lefthook"],
      }).verdict,
    ).toBe("ok");
  });
});
