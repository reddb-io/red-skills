import { describe, expect, it } from "vitest";
import { createIssue, listCandidates, type GhContext } from "../src/runtime/gh.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

interface Recorder {
  exec: ExecFn;
  calls: { cmd: string; args: string[] }[];
}

function recording(stdout: string, code = 0, stderr = ""): Recorder {
  const calls: { cmd: string; args: string[] }[] = [];
  const out: ExecOutput = { code, stdout, stderr };
  const exec: ExecFn = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    return Promise.resolve(out);
  };
  return { exec, calls };
}

describe("createIssue", () => {
  it("resolves the new number from the issues URL gh prints", async () => {
    // The routed REST write (#3730): `gh api -X POST repos/.../issues`, and the
    // create response's `html_url` field is the URL the number is pulled from.
    const rec = recording(JSON.stringify({ html_url: "https://github.com/acme/widgets/issues/4242" }));
    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", exec: rec.exec };
    const num = await createIssue(ctx, { title: "/go: x", body: "demand", labels: ["lane:go"] });
    expect(num).toBe(4242);
    const args = rec.calls[0]!.args;
    expect(args.slice(0, 3)).toEqual(["api", "-X", "POST"]);
    expect(args).toContain("repos/acme/widgets/issues");
    expect(args).toContain("-f");
    expect(args).toContain("title=/go: x");
    // Each label is its own -F labels[]= so a comma in a value is never split.
    expect(args.filter((a) => a === "labels[]=lane:go")).toHaveLength(1);
  });

  it("throws when gh exits non-zero (a failed mint is never a created issue)", async () => {
    const rec = recording("", 1, "gh: not authenticated");
    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", exec: rec.exec };
    await expect(createIssue(ctx, { title: "t", body: "b" })).rejects.toThrow(/failed to create issue/);
  });

  it("throws on an unparseable stdout", async () => {
    const rec = recording("created, but no url here\n", 0);
    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", exec: rec.exec };
    await expect(createIssue(ctx, { title: "t", body: "b" })).rejects.toThrow(/failed to create issue/);
  });
});

describe("listCandidates lane", () => {
  it("lists ready-for-agent by default", async () => {
    const rec = recording("[]");
    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", exec: rec.exec };
    await listCandidates(ctx);
    expect(rec.calls[0]!.cmd).toBe("rsp");
    expect(rec.calls[0]!.args).toContain("labels=ready-for-agent");
  });

  it("lists the given lane label when /go passes one", async () => {
    const rec = recording("[]");
    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", exec: rec.exec };
    await listCandidates(ctx, "lane:go");
    const args = rec.calls[0]!.args;
    expect(rec.calls[0]!.cmd).toBe("rsp");
    expect(args).toContain("labels=lane:go");
    expect(args).not.toContain("labels=ready-for-agent");
  });
});
