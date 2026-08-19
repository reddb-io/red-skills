import { describe, expect, it } from "vitest";
import { resolveSelectorUser, resolveViewerLogin } from "../src/runtime/gh.js";
import type { ExecFn } from "../src/runtime/exec.js";

describe("resolveViewerLogin (@me concretization)", () => {
  it("returns the trimmed gh api user login", async () => {
    const exec: ExecFn = async (tool, args) => {
      expect(tool).toBe("gh");
      expect(args).toEqual(["api", "user", "-q", ".login"]);
      return { code: 0, stdout: "octocat\n", stderr: "" };
    };
    await expect(resolveViewerLogin({ cwd: "/repo", repo: "o/r", exec })).resolves.toBe("octocat");
  });

  it("throws when gh cannot answer, instead of leaving a never-matching @me", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "boom" });
    await expect(resolveViewerLogin({ cwd: "/repo", repo: "o/r", exec })).rejects.toThrow(/@me/);
  });
});

describe("resolveSelectorUser", () => {
  it("replaces only the literal @me and never calls gh otherwise", async () => {
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return "octocat";
    };
    await expect(
      resolveSelectorUser({ tags: ["infra"], user: "@me" }, resolve),
    ).resolves.toEqual({ tags: ["infra"], user: "octocat" });
    await expect(resolveSelectorUser({ user: "someone" }, resolve)).resolves.toEqual({
      user: "someone",
    });
    await expect(resolveSelectorUser({}, resolve)).resolves.toEqual({});
    expect(calls).toBe(1);
  });
});
