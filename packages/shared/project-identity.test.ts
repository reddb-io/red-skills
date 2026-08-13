import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  declaredProjectNameInConfig,
  PROJECT_NAME_CONFIG_KEY,
  resolveProjectIdentity,
  type ProjectIdentityInput,
} from "./project-identity.js";
import { resolveProjectIdentityForDir } from "./project-identity-resolve.js";

/**
 * Table-driven and filesystem-free by contract: every case is a literal input
 * record, so the resolver is proven pure over its inputs rather than over a
 * checkout that happens to exist on the machine running the suite.
 */

const MAIN: ProjectIdentityInput = {
  checkoutPath: "/home/dev/code/red-skills",
  gitCommonDir: "/home/dev/code/red-skills/.git",
  remoteUrl: "git@github.com:reddb-io/red-skills.git",
};

const CLONE: ProjectIdentityInput = {
  checkoutPath: "/home/dev/other/red-skills",
  gitCommonDir: "/home/dev/other/red-skills/.git",
  remoteUrl: "git@github.com:reddb-io/red-skills.git",
};

const WORKTREE: ProjectIdentityInput = {
  checkoutPath: "/home/dev/code/red-skills/.red/tmp/workers/w1/2778/worktree",
  gitCommonDir: "/home/dev/code/red-skills/.git",
  remoteUrl: "git@github.com:reddb-io/red-skills.git",
};

describe("resolveProjectIdentity — name resolution order", () => {
  const cases: { readonly label: string; readonly input: ProjectIdentityInput; readonly name: string; readonly source: string }[] = [
    {
      label: "a declared name wins over the remote",
      input: { ...MAIN, declaredName: "Red Skills" },
      name: "Red Skills",
      source: "declared",
    },
    {
      label: "a blank declared name is not a declaration",
      input: { ...MAIN, declaredName: "   " },
      name: "reddb-io/red-skills",
      source: "remote",
    },
    {
      label: "the remote wins over the basename",
      input: MAIN,
      name: "reddb-io/red-skills",
      source: "remote",
    },
    {
      label: "no remote and no declared name falls back to the checkout basename",
      input: { checkoutPath: "/home/dev/code/scratch-repo", gitCommonDir: "/home/dev/code/scratch-repo/.git" },
      name: "scratch-repo",
      source: "basename",
    },
    {
      label: "the basename fallback names the main checkout, not the worktree directory",
      input: { checkoutPath: "/home/dev/code/red-skills/.red/tmp/workers/w1/2778/worktree", gitCommonDir: "/home/dev/code/red-skills/.git" },
      name: "red-skills",
      source: "basename",
    },
    {
      label: "outside a git checkout the basename of the path is used",
      input: { checkoutPath: "/home/dev/code/loose-dir" },
      name: "loose-dir",
      source: "basename",
    },
    {
      label: "an https remote resolves owner/repo",
      input: { ...MAIN, remoteUrl: "https://github.com/reddb-io/red-skills.git" },
      name: "reddb-io/red-skills",
      source: "remote",
    },
    {
      label: "an ssh:// remote resolves owner/repo",
      input: { ...MAIN, remoteUrl: "ssh://git@github.com:22/reddb-io/red-skills.git" },
      name: "reddb-io/red-skills",
      source: "remote",
    },
    {
      label: "a nested group remote keeps the last two segments",
      input: { ...MAIN, remoteUrl: "https://gitlab.com/group/sub/red-skills.git" },
      name: "sub/red-skills",
      source: "remote",
    },
    {
      label: "a single-segment remote resolves the repo name alone",
      input: { ...MAIN, remoteUrl: "https://example.com/red-skills.git" },
      name: "red-skills",
      source: "remote",
    },
    {
      label: "an unparseable remote falls through to the basename",
      input: { ...MAIN, remoteUrl: "not a url" },
      name: "red-skills",
      source: "basename",
    },
  ];

  for (const testCase of cases) {
    it(testCase.label, () => {
      const identity = resolveProjectIdentity(testCase.input);
      expect(identity.name).toBe(testCase.name);
      expect(identity.source).toBe(testCase.source);
    });
  }
});

describe("resolveProjectIdentity — slug", () => {
  it("always carries a short hash, with no collision needed to earn it", () => {
    const identity = resolveProjectIdentity(MAIN);
    expect(identity.slug).toMatch(/^reddb-io--red-skills-[0-9a-f]{8}$/);
    expect(identity.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(identity.slug.endsWith(identity.hash)).toBe(true);
  });

  it("gives two independent clones of one repository different slugs", () => {
    const main = resolveProjectIdentity(MAIN);
    const clone = resolveProjectIdentity(CLONE);
    expect(main.name).toBe(clone.name);
    expect(main.slug).not.toBe(clone.slug);
  });

  it("collapses a worktree onto the project its main checkout owns", () => {
    expect(resolveProjectIdentity(WORKTREE).slug).toBe(resolveProjectIdentity(MAIN).slug);
  });

  it("ignores a trailing separator on the git common directory", () => {
    const trailing = resolveProjectIdentity({ ...MAIN, gitCommonDir: "/home/dev/code/red-skills/.git/" });
    expect(trailing.slug).toBe(resolveProjectIdentity(MAIN).slug);
  });

  it("hashes the checkout path when there is no git common directory", () => {
    const a = resolveProjectIdentity({ checkoutPath: "/home/dev/a/loose" });
    const b = resolveProjectIdentity({ checkoutPath: "/home/dev/b/loose" });
    expect(a.name).toBe(b.name);
    expect(a.slug).not.toBe(b.slug);
  });

  const slugCases: { readonly label: string; readonly declaredName: string; readonly slugBase: string }[] = [
    { label: "lowercases and hyphenates a display name", declaredName: "Red Skills", slugBase: "red-skills" },
    { label: "maps a path separator to a double hyphen", declaredName: "reddb-io/red-skills", slugBase: "reddb-io--red-skills" },
    { label: "collapses runs of punctuation inside a segment", declaredName: "red__.. skills", slugBase: "red-skills" },
    { label: "trims leading and trailing separators", declaredName: " -Red Skills- ", slugBase: "red-skills" },
    { label: "drops empty path segments", declaredName: "owner//repo", slugBase: "owner--repo" },
    { label: "falls back to `project` when nothing survives slugification", declaredName: "!!!", slugBase: "project" },
    { label: "keeps digits", declaredName: "Repo 2778", slugBase: "repo-2778" },
  ];

  for (const testCase of slugCases) {
    it(testCase.label, () => {
      const identity = resolveProjectIdentity({ ...MAIN, declaredName: testCase.declaredName });
      expect(identity.slug).toBe(`${testCase.slugBase}-${identity.hash}`);
    });
  }
});

describe("declaredProjectNameInConfig", () => {
  it("names the sanctioned root key", () => {
    expect(PROJECT_NAME_CONFIG_KEY).toBe("project.name");
  });

  it("reads a root-level project.name", () => {
    expect(declaredProjectNameInConfig("project:\n  name: Red Skills\n")).toBe("Red Skills");
  });

  it("reads it without any plugin being enabled", () => {
    expect(declaredProjectNameInConfig("project:\n  name: Red Skills\nplugins:\n  dev:\n    enabled: false\n"))
      .toBe("Red Skills");
  });

  it("is undefined when absent", () => {
    expect(declaredProjectNameInConfig("plugins:\n  dev:\n    enabled: true\n")).toBeUndefined();
  });

  it("is undefined when the key carries no value", () => {
    expect(declaredProjectNameInConfig("project:\n  name:\n")).toBeUndefined();
  });
});

describe("resolveProjectIdentity — purity", () => {
  it("returns the same identity for the same inputs", () => {
    expect(resolveProjectIdentity(MAIN)).toEqual(resolveProjectIdentity({ ...MAIN }));
  });

  it("does not mutate its input", () => {
    const input = { ...MAIN };
    resolveProjectIdentity(input);
    expect(input).toEqual(MAIN);
  });
});

describe("resolveProjectIdentityForDir — git fixtures", () => {
  it("resolves a primary checkout and sibling worktree to one project", () => {
    const fixture = mkdtempSync(join(tmpdir(), "project-identity-worktree-"));
    const primary = join(fixture, "primary");
    const sibling = join(fixture, "sibling");
    mkdirSync(primary);
    execFileSync("git", ["init", "-q"], { cwd: primary });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: primary });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: primary });
    execFileSync("git", ["remote", "add", "origin", "git@example.invalid:owner/project.git"], { cwd: primary });
    writeFileSync(join(primary, "README.md"), "fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: primary });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: primary });
    execFileSync("git", ["worktree", "add", "-q", "-b", "fixture-sibling", sibling], { cwd: primary });

    expect(resolveProjectIdentityForDir(sibling)).toEqual(resolveProjectIdentityForDir(primary));
  });
});
