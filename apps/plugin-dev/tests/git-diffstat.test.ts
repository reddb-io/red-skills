import { describe, expect, it } from "vitest";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";
import { diffstatShortstat } from "../src/runtime/git.js";

/** A recording exec fake driven by a per-`git <subcommand>` response table. */
function fakeExec(
  table: Record<string, ExecOutput>,
  calls: string[][],
): ExecFn {
  return (_cmd, args) => {
    calls.push([...args]);
    const key = args[0] ?? "";
    return Promise.resolve(table[key] ?? { code: 1, stdout: "", stderr: "" });
  };
}

const ok = (stdout: string): ExecOutput => ({ code: 0, stdout, stderr: "" });

describe("diffstatShortstat — counts committed + uncommitted from the merge-base", () => {
  it("diffs against merge-base(base, HEAD), not the bare base, so committed work counts", async () => {
    const calls: string[][] = [];
    const exec = fakeExec(
      {
        "merge-base": ok("abc1234\n"),
        diff: ok(" 5 files changed, 1788 insertions(+), 3 deletions(-)\n"),
      },
      calls,
    );

    const stat = await diffstatShortstat({ cwd: "/wt", exec }, "origin/main");

    expect(stat).toEqual({ added: 1788, removed: 3 });
    // merge-base was resolved first…
    expect(calls[0]).toEqual(["merge-base", "origin/main", "HEAD"]);
    // …and the diff used the resolved commit, NOT the bare "origin/main".
    expect(calls[1]).toEqual(["diff", "--shortstat", "abc1234"]);
  });

  it("falls back to a plain base diff when no merge-base resolves (unborn branch)", async () => {
    const calls: string[][] = [];
    const exec = fakeExec(
      {
        "merge-base": { code: 1, stdout: "", stderr: "no merge base" },
        diff: ok(" 1 file changed, 2 insertions(+)\n"),
      },
      calls,
    );

    const stat = await diffstatShortstat({ cwd: "/wt", exec }, "origin/main");

    expect(stat).toEqual({ added: 2, removed: 0 });
    expect(calls[1]).toEqual(["diff", "--shortstat", "origin/main"]);
  });

  it("defaults to 0/0 when the diff itself fails", async () => {
    const exec = fakeExec({ "merge-base": ok("abc\n") }, []);
    expect(await diffstatShortstat({ cwd: "/wt", exec }, "origin/main")).toEqual({
      added: 0,
      removed: 0,
    });
  });
});
