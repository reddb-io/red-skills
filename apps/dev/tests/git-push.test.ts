import { describe, expect, it } from "vitest";
import { pushForceWithLease } from "../src/runtime/git-push.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

interface Recorder {
  exec: ExecFn;
  calls: { cmd: string; args: string[]; cwd?: string }[];
}

function recording(out: ExecOutput): Recorder {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const exec: ExecFn = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts?.cwd });
    return Promise.resolve(out);
  };
  return { exec, calls };
}

describe("pushForceWithLease — the /dev fix push surface", () => {
  it("pushes HEAD to the PR branch with --force-with-lease from the given cwd", async () => {
    const rec = recording({ code: 0, stdout: "", stderr: "" });
    const result = await pushForceWithLease({ cwd: "/wt", branch: "feature/x", exec: rec.exec });

    expect(result).toEqual({ pushed: true, stale: false, reason: "" });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toEqual({
      cmd: "git",
      args: ["push", "--force-with-lease", "origin", "HEAD:feature/x"],
      cwd: "/wt",
    });
  });

  it("honours a custom remote", async () => {
    const rec = recording({ code: 0, stdout: "", stderr: "" });
    await pushForceWithLease({ cwd: "/wt", branch: "b", remote: "upstream", exec: rec.exec });
    expect(rec.calls[0]!.args).toEqual(["push", "--force-with-lease", "upstream", "HEAD:b"]);
  });

  it("reports a stale-branch refusal (does NOT clobber) when the remote advanced", async () => {
    const stderr =
      "! [rejected]        HEAD -> feature/x (stale info)\n" +
      "error: failed to push some refs";
    const rec = recording({ code: 1, stdout: "", stderr });
    const result = await pushForceWithLease({ cwd: "/wt", branch: "feature/x", exec: rec.exec });

    expect(result.pushed).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain("stale info");
  });

  it("classifies a non-fast-forward rejection as stale", async () => {
    const rec = recording({ code: 1, stdout: "", stderr: "Updates were rejected (non-fast-forward); fetch first" });
    const result = await pushForceWithLease({ cwd: "/wt", branch: "b", exec: rec.exec });
    expect(result.pushed).toBe(false);
    expect(result.stale).toBe(true);
  });

  it("a non-stale failure (auth, no remote) is reported but not flagged stale", async () => {
    const rec = recording({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com'" });
    const result = await pushForceWithLease({ cwd: "/wt", branch: "b", exec: rec.exec });
    expect(result.pushed).toBe(false);
    expect(result.stale).toBe(false);
    expect(result.reason).toContain("could not read Username");
  });
});
