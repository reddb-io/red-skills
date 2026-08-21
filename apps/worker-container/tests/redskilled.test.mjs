import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalRedskilledInvocation,
  pathRedskilledInvocation,
  redSkillsVersion,
  redskilledInvocation,
  RED_SKILLS_PACKAGE,
  REDSKILLED_BINARY,
} from "../src/redskilled.mjs";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

describe("the container names a binary the repository ships (#4118)", () => {
  it("names the bin-map entry of the published package, not a deleted one", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "packaging", "npm", "package.json"), "utf8"),
    );

    expect(manifest.name).toBe(RED_SKILLS_PACKAGE);
    expect(Object.keys(manifest.bin)).toContain(REDSKILLED_BINARY);
  });

  it("composes the ADR 0091 canonical form by default", () => {
    expect(redskilledInvocation({ RED_SKILLS_VERSION: "4.1.15" }, ["serve"])).toEqual([
      "npx", "-y", "-p", "@reddb-io/red-skills@4.1.15", REDSKILLED_BINARY, "serve",
    ]);
  });

  it("takes the warm-cache PATH form only when the environment declares it", () => {
    expect(redskilledInvocation({ RED_SKILLS_INVOCATION: "path" }, ["acp"]))
      .toEqual([REDSKILLED_BINARY, "acp"]);
    expect(pathRedskilledInvocation(["acp-worker"])).toEqual([REDSKILLED_BINARY, "acp-worker"]);
  });

  it("falls back to `latest` when the image was built without a pin", () => {
    expect(redSkillsVersion({})).toBe("latest");
    expect(canonicalRedskilledInvocation({}, [])[3]).toBe("@reddb-io/red-skills@latest");
  });
});
