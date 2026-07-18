import { describe, expect, it } from "vitest";
import {
  attachSubIssue,
  listSpecSubIssueCandidates,
  type GhContext,
} from "../src/runtime/gh.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

interface Recorder {
  exec: ExecFn;
  calls: { cmd: string; args: string[] }[];
}

function makeRecorder(respond: (args: readonly string[]) => ExecOutput): Recorder {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: ExecFn = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    return Promise.resolve(respond(args));
  };
  return { exec, calls };
}

describe("listSpecSubIssueCandidates", () => {
  it("walks open and recently closed Specs, label children, and native sub-issues", async () => {
    const rec = makeRecorder((args) => {
      const joined = args.join(" ");
      if (joined.includes("issue list") && joined.includes("--label type:spec")) {
        return {
          code: 0,
          stdout: JSON.stringify([
            { number: 42, state: "OPEN", closedAt: null, labels: [{ name: "type:spec" }, { name: "needs-slicing" }] },
            { number: 43, state: "CLOSED", closedAt: "2026-01-01T00:00:00Z", labels: [{ name: "type:spec" }] },
          ]),
          stderr: "",
        };
      }
      if (joined.includes("issue list") && joined.includes("--label spec:42")) {
        return {
          code: 0,
          stdout: JSON.stringify([{ number: 7, labels: [{ name: "spec:42" }] }]),
          stderr: "",
        };
      }
      if (joined.includes("issue list") && joined.includes("--label spec:43")) {
        return { code: 0, stdout: JSON.stringify([]), stderr: "" };
      }
      if (joined.includes("issues/42/sub_issues")) {
        return { code: 0, stdout: `${JSON.stringify({ number: 8 })}\n`, stderr: "" };
      }
      if (joined.includes("issues/43/sub_issues")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    });

    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", exec: rec.exec };
    const candidates = await listSpecSubIssueCandidates(ctx, Date.parse("2026-01-15T00:00:00Z") / 1000);

    expect(candidates).toEqual([
      { number: 42, labels: ["type:spec", "needs-slicing"], labelChildren: [7], nativeSubIssues: [8] },
      { number: 43, labels: ["type:spec"], labelChildren: [], nativeSubIssues: [] },
    ]);
  });
});

describe("attachSubIssue", () => {
  it("resolves the child database id and posts the native sub-issue edge", async () => {
    const rec = makeRecorder((args) => {
      const joined = args.join(" ");
      if (joined.includes("issues/7") && joined.includes("--jq .id")) {
        return { code: 0, stdout: "12345\n", stderr: "" };
      }
      if (joined.includes("issues/42/sub_issues")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    });
    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", exec: rec.exec };

    await attachSubIssue(ctx, 42, 7);

    expect(rec.calls).toEqual([
      {
        cmd: "gh",
        args: ["api", "repos/acme/widgets/issues/7", "--jq", ".id"],
      },
      {
        cmd: "gh",
        args: ["api", "-X", "POST", "repos/acme/widgets/issues/42/sub_issues", "-F", "sub_issue_id=12345"],
      },
    ]);
  });
});
