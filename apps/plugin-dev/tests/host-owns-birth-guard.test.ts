// The ratchet that keeps the daemon the only launcher (#2851, ADR 0130).
//
// The live assertion runs against the real tree: every declared per-project
// module must hold no way to put a process on the machine. The unit cases below
// prove the ratchet itself can fail — a guard that cannot go red is a guard that
// proves nothing, which is how #2784 shipped its criterion unmet.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectHostOwnedBirthFindings,
  formatHostOwnedBirthFailure,
  HOST_OWNED_BIRTH_SITES,
  type HostOwnedBirthSite,
} from "../src/core/host-owns-birth-guard.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

const SITE: HostOwnedBirthSite = {
  path: "apps/plugin-dev/src/commands/supervise.ts",
  what: "the per-slot Worker spawn",
  replacement: "the birth port",
};

const RETIRED_MCP_SITE: HostOwnedBirthSite = {
  path: "apps/plugin-dev/src/mcp-adapter.ts",
  what: "the retired MCP dispatch spawn",
  replacement: "the public redskilled ACP Project endpoint",
  removed: true,
};

describe("the per-project runtime holds no way to birth a Worker", () => {
  it("finds no process-creation reach in any declared site", () => {
    const findings = collectHostOwnedBirthFindings(REPO_ROOT);
    expect(formatHostOwnedBirthFailure(findings)).toBe("");
  });

  it("declares every module the cutover emptied", () => {
    // Named rather than counted: a slice that empties one more module adds it
    // here, and a slice that quietly drops one is what this refuses.
    expect(HOST_OWNED_BIRTH_SITES.map((site) => site.path)).toContain(
      "apps/plugin-dev/src/commands/supervise.ts",
    );
    // The MCP adapter is contracted away rather than retained as a private
    // birth port. Its extinction is owned by retired-authority-guard.
    expect(HOST_OWNED_BIRTH_SITES.map((site) => site.path))
      .not.toContain("apps/plugin-dev/src/mcp-adapter.ts");
    for (const site of HOST_OWNED_BIRTH_SITES) {
      expect(site.what.trim()).not.toBe("");
      expect(site.replacement.trim()).not.toBe("");
    }
  });
});

describe("the ratchet can go red", () => {
  it("catches a bare `spawn(` reintroduced into a declared site", () => {
    const findings = collectHostOwnedBirthFindings(
      "/repo",
      [SITE],
      () => "const child = spawn(process.execPath, args);\n",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.match).toBe("spawn(");
    expect(formatHostOwnedBirthFailure(findings)).toContain("apps/plugin-dev/src/commands/supervise.ts:1");
    expect(formatHostOwnedBirthFailure(findings)).toContain("the birth port");
  });

  it("catches the retired MCP dispatch site if it is resurrected", () => {
    const findings = collectHostOwnedBirthFindings(
      "/repo",
      [RETIRED_MCP_SITE],
      () => 'const child = spawn(process.execPath, [bundle, "run", ...args], { detached: true });\n',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.match).toBe("<resurrected>");
    expect(formatHostOwnedBirthFailure(findings)).toContain("public redskilled ACP Project endpoint");
  });

  it("catches an import of child_process, even with no call beside it", () => {
    const findings = collectHostOwnedBirthFindings(
      "/repo",
      [SITE],
      () => 'import { spawn as later } from "node:child_process";\n',
    );

    expect(findings).toHaveLength(1);
  });

  it("catches `execFile`, not only the api a reader expects", () => {
    const findings = collectHostOwnedBirthFindings("/repo", [SITE], () => "await execFile(cmd, args);\n");

    expect(findings).toHaveLength(1);
    expect(findings[0]!.match).toBe("execFile(");
  });

  it("treats a declared site that no longer exists as a finding, never a pass", () => {
    // A module renamed out from under the list would empty the ratchet with
    // nothing failing — the same invisibility the ratchet exists to close.
    const findings = collectHostOwnedBirthFindings("/repo", [SITE], () => null);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.match).toBe("<missing>");
  });

  it("reads prose about a removed spawn as documentation, not as a spawn", () => {
    const findings = collectHostOwnedBirthFindings(
      "/repo",
      [SITE],
      () => "// This used to call spawn(process.execPath, args); it asks the host now.\n",
    );

    expect(findings).toEqual([]);
  });

  it("reads a spawn named inside a string as text, not as a call", () => {
    const findings = collectHostOwnedBirthFindings(
      "/repo",
      [SITE],
      () => 'log("the old path called spawn(...) here");\n',
    );

    expect(findings).toEqual([]);
  });
});
