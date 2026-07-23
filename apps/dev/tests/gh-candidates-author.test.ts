import { describe, expect, it } from "vitest";
import { listCandidates } from "../src/runtime/gh.js";
import type { ExecFn } from "../src/runtime/exec.js";

describe("listCandidates author projection (territory --user facet)", () => {
  it("maps the REST fast path's user.login onto candidate.author", async () => {
    const exec: ExecFn = async (tool) => {
      if (tool === "rsp") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              number: 1,
              title: "authored",
              body: "",
              labels: [{ name: "ready-for-agent" }],
              user: { login: "octocat" },
            },
            { number: 2, title: "authorless", body: "", labels: [] },
          ]),
          stderr: "",
        };
      }
      throw new Error(`unexpected tool: ${tool}`);
    };
    const rows = await listCandidates({ cwd: "/repo", repo: "o/r", exec });
    expect(rows.map((r) => r.author)).toEqual(["octocat", undefined]);
  });

  it("maps the gh fallback's author.login onto candidate.author and requests the field", async () => {
    const calls: Array<{ tool: string; args: readonly string[] }> = [];
    const exec: ExecFn = async (tool, args) => {
      calls.push({ tool, args });
      // rsp fast path unavailable → fall back to gh issue list.
      if (tool === "rsp") return { code: 1, stdout: "", stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            number: 3,
            title: "fallback",
            body: "",
            labels: [{ name: "ready-for-agent" }],
            author: { login: "octocat" },
          },
        ]),
        stderr: "",
      };
    };
    const rows = await listCandidates({ cwd: "/repo", repo: "o/r", exec });
    expect(rows).toEqual([
      {
        number: 3,
        title: "fallback",
        body: "",
        labels: ["ready-for-agent"],
        author: "octocat",
      },
    ]);
    const ghCall = calls.find((c) => c.tool === "gh");
    expect(ghCall?.args).toContain("number,title,labels,body,author");
  });
});
