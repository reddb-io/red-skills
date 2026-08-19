import assert from "node:assert/strict";
import test from "node:test";

import { matchPathBriefs, parseSkillPaths } from "./lib/path-briefs.mjs";

test("parseSkillPaths reads an ordered block glob list", () => {
  const source = `---
name: guard
description: Guard a source surface.
paths:
  - apps/plugin-dev/**/*.ts
  - packages/shared/*.ts
---
Brief body.
`;

  assert.deepEqual(parseSkillPaths(source), [
    "apps/plugin-dev/**/*.ts",
    "packages/shared/*.ts",
  ]);
});

test("parseSkillPaths reads inline lists and quoted globs", () => {
  const source = `---
name: guard
description: Guard a source surface.
paths: ["apps/{dev,memory}/**/*.ts", plugins/*/SKILL.md]
---
`;

  assert.deepEqual(parseSkillPaths(source), [
    "apps/{dev,memory}/**/*.ts",
    "plugins/*/SKILL.md",
  ]);
});

test("parseSkillPaths rejects malformed or repository-escaping globs", () => {
  for (const glob of [
    "apps/[broken.ts",
    "apps/[].ts",
    "apps/*.{ts}",
    "apps/**broken/*.ts",
    "../secrets/**",
    "/tmp/**",
  ]) {
    const source = `---
name: guard
description: Guard a source surface.
paths:
  - ${glob}
---
`;
    assert.throws(() => parseSkillPaths(source), /invalid paths glob/);
  }
});

test("parseSkillPaths rejects a paths scalar instead of silently disabling the brief", () => {
  assert.throws(
    () => parseSkillPaths(`---
name: guard
description: Guard a source surface.
paths: apps/plugin-dev/**
---
`),
    /paths must be a non-empty glob list/,
  );
});

test("matchPathBriefs returns matching declarations in source order", () => {
  const briefs = [
    { name: "typescript", paths: ["apps/**/[a-z]*.{ts,tsx}"] },
    { name: "skill-doc", paths: ["**/SKILL.md"] },
    { name: "dev-config", paths: ["apps/plugin-dev/src/config?.ts"] },
  ];

  assert.deepEqual(
    matchPathBriefs(briefs, "apps\\dev\\src\\config1.ts").map((brief) => brief.name),
    ["typescript", "dev-config"],
  );
  assert.deepEqual(
    matchPathBriefs(briefs, "plugins/dev/skills/afk/SKILL.md").map((brief) => brief.name),
    ["skill-doc"],
  );
  assert.deepEqual(matchPathBriefs(briefs, "apps/plugin-dev/src/1.ts"), []);
});
