import { describe, expect, it } from "vitest";
import {
  canEditRedactTarget,
  findRedactionHits,
  redactText,
  scanRedactTargets,
  type RedactTarget,
} from "../src/core/redact-sweep.js";
import { redactSweepCommand, type RedactSweepGitHub } from "../src/commands/redact-sweep.js";
import { parseCli } from "../src/cli.js";

const CONFIG = {
  hostPatterns: ["cyber-XPS", "build-host"],
};

function target(body: string, author = "alice"): RedactTarget {
  return {
    kind: "issue-comment",
    repo: "reddb-io/red-skills",
    id: 10,
    url: "https://github.com/reddb-io/red-skills/issues/1#issuecomment-10",
    author,
    body,
  };
}

function collect(): { stream: NodeJS.WritableStream; text: () => string } {
  let buf = "";
  const stream = { write: (s: string) => (buf += s, true) } as unknown as NodeJS.WritableStream;
  return { stream, text: () => buf };
}

function fakeGh(targets: RedactTarget[]): RedactSweepGitHub & {
  updates: Array<{ url: string; body: string }>;
} {
  const updates: Array<{ url: string; body: string }> = [];
  return {
    updates,
    viewerLogin: async () => "alice",
    listTargets: async () => targets,
    updateTarget: async (item, body) => {
      updates.push({ url: item.url, body });
      item.body = body;
    },
  };
}

describe("redact-sweep detection and redaction", () => {
  it("detects claude session links, configured host patterns, and /home paths", () => {
    const text = [
      "session https://claude.ai/code/session_01ABCxyz",
      "host cyber-XPS-9560 and build-host",
      "path /home/cyber/Work/reddb.io/red-skills/file.ts",
    ].join("\n");

    expect(findRedactionHits(text, CONFIG).map((hit) => hit.class)).toEqual([
      "claude-session",
      "host",
      "host",
      "home-path",
    ]);
  });

  it("redacts each leak class with stable placeholders", () => {
    const text = "https://claude.ai/code/session_secret on cyber-XPS-13 in /home/cyber/project";
    expect(redactText(text, CONFIG).text).toBe(
      "[REDACTED_CLAUDE_SESSION] on [REDACTED_HOST] in /home/[REDACTED_USER]/project",
    );
  });

  it("is idempotent after redaction", () => {
    const first = redactText("https://claude.ai/code/session_secret /home/cyber/project cyber-XPS-13", CONFIG);
    expect(findRedactionHits(first.text, CONFIG)).toEqual([]);
    expect(redactText(first.text, CONFIG).text).toBe(first.text);
  });

  it("skips targets not authored by the authenticated actor", () => {
    expect(canEditRedactTarget(target("leak", "alice"), "alice")).toBe(true);
    expect(canEditRedactTarget(target("leak", "bob"), "alice")).toBe(false);
  });

  it("plans editable hits and reports other authors as skipped", () => {
    const result = scanRedactTargets(
      [
        target("https://claude.ai/code/session_secret", "alice"),
        target("/home/bob/project", "bob"),
        target("ordinary text", "alice"),
      ],
      "alice",
      CONFIG,
    );

    expect(result.editable.map((item) => item.target.id)).toEqual([10]);
    expect(result.skipped.map((item) => item.target.author)).toEqual(["bob"]);
    expect(result.clean.map((item) => item.id)).toEqual([10]);
  });

  it("routes the dev CLI redact-sweep command", () => {
    expect(parseCli(["redact-sweep", "--repo", "reddb-io/red-skills", "--json"])).toEqual({
      command: "redact-sweep",
      args: ["--repo", "reddb-io/red-skills", "--json"],
    });
  });

  it("defaults to dry-run and writes nothing", async () => {
    const gh = fakeGh([target("https://claude.ai/code/session_secret from /home/cyber/project")]);
    const out = collect();
    const code = await redactSweepCommand(["--repo", "reddb-io/red-skills"], "/repo", out.stream, gh);

    expect(code).toBe(0);
    expect(out.text()).toContain("redact-sweep (dry-run) reddb-io/red-skills: 1 editable hit(s), 0 skipped");
    expect(out.text()).toContain("[REDACTED_CLAUDE_SESSION] from /home/[REDACTED_USER]/project");
    expect(gh.updates).toEqual([]);
  });

  it("--apply edits only authenticated-user targets and is replay-idempotent", async () => {
    const gh = fakeGh([
      target("https://claude.ai/code/session_secret from /home/cyber/project"),
      target("cyber-XPS-13 from /home/bob/project", "bob"),
    ]);
    const first = collect();
    expect(await redactSweepCommand(["--repo", "reddb-io/red-skills", "--apply"], "/repo", first.stream, gh)).toBe(0);

    expect(gh.updates).toEqual([
      {
        url: "https://github.com/reddb-io/red-skills/issues/1#issuecomment-10",
        body: "[REDACTED_CLAUDE_SESSION] from /home/[REDACTED_USER]/project",
      },
    ]);
    expect(first.text()).toContain("1 editable hit(s), 1 skipped");

    gh.updates.length = 0;
    const second = collect();
    expect(await redactSweepCommand(["--repo", "reddb-io/red-skills", "--apply"], "/repo", second.stream, gh)).toBe(0);
    expect(gh.updates).toEqual([]);
    expect(second.text()).toContain("0 editable hit(s), 1 skipped");
  });
});
