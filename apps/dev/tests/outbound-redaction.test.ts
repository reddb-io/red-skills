import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { comment, createIssue, editBody, postClaimComment, updateMainRedRepairIssue, type GhContext } from "../src/runtime/gh.js";
import { buildReviewGh } from "../src/runtime/review-gh.js";
import { scrubOutbound } from "../src/runtime/outbound-redaction.js";
import { landPr, type Exec } from "../src/core/merge.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

const LEAK_ENV_KEY = "RED_SKILLS_TEST_TOKEN";
const LEAK_ENV_VALUE = "red-skills-test-token-123456";
const LEAK_TEXT = [
  "session https://claude.ai/code/session_abc123_X-y",
  `literal ${LEAK_ENV_VALUE}`,
  "OPENAI_API_KEY=sk-test-123456789",
  '{"github_token":"ghp_1234567890abcdef"}',
  "/home/cyber/.config/red-skills",
].join("\n");

function withSyntheticEnv(): void {
  process.env[LEAK_ENV_KEY] = LEAK_ENV_VALUE;
}

afterEach(() => {
  delete process.env[LEAK_ENV_KEY];
});

function expectScrubbed(value: string): void {
  expect(value).not.toContain("claude.ai/code/session_");
  expect(value).not.toContain(LEAK_ENV_VALUE);
  expect(value).not.toContain("sk-test-123456789");
  expect(value).not.toContain("ghp_1234567890abcdef");
  expect(value).not.toContain("/home/cyber");
  expect(value).toContain("[REDACTED_CLAUDE_SESSION]");
  expect(value).toContain("[REDACTED_SECRET]");
  expect(value).toContain("[REDACTED_HOME]");
}

describe("scrubOutbound", () => {
  it("redacts session links, env values, key-value secrets, home paths, host and user identity", () => {
    const input = [
      LEAK_TEXT,
      "TOKEN=another-secret-value",
      '{"secret":"json-secret-value"}',
      "/home/alice/project /Users/bob/project host-a alice",
      "<!-- afk:claim v1 worker=host-a:w123 kind=claim runner=codex -->",
    ].join("\n");

    const out = scrubOutbound(input, {
      env: { [LEAK_ENV_KEY]: LEAK_ENV_VALUE },
      homeDir: "/home/alice",
      hostname: "host-a",
      username: "alice",
      hostReplacement: "hostfingerprint",
    });

    expectScrubbed(out);
    expect(out).toContain("TOKEN=[REDACTED_SECRET]");
    expect(out).toContain('"secret":"[REDACTED_SECRET]"');
    expect(out).toContain("[REDACTED_HOME]/project");
    expect(out).toContain("/Users/[REDACTED_USER]/project");
    expect(out).toContain("hostfingerprint [REDACTED_USER]");
  });

  it("is idempotent and preserves non-leaking machine markers byte-identical", () => {
    const marker = [
      "<!-- afk:claim v1 worker=8cb3eafdcbd2:w95PS kind=claim runner=codex -->",
      "<!-- red:hitl-card v1 -->",
      "<!-- red:blocker-state v1 -->",
      "Refs #1365",
    ].join("\n");

    const once = scrubOutbound(marker);
    expect(once).toBe(marker);
    expect(scrubOutbound(once)).toBe(once);
  });

  it("never throws on non-string and binary-ish input", () => {
    expect(typeof scrubOutbound(Buffer.from([0, 1, 2, 255]))).toBe("string");
    expect(scrubOutbound(null)).toBe("");
  });
});

describe("GitHub outbound write seams", () => {
  it("scrubs issue comments, claim comments, issue body edits, issue creation, and main-red repair updates", async () => {
    withSyntheticEnv();
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: ExecFn = async (cmd, args): Promise<ExecOutput> => {
      calls.push({ cmd, args: [...args] });
      if (args.includes("--jq")) return { code: 0, stdout: "123\n", stderr: "" };
      if (args[0] === "issue" && args[1] === "create") {
        return { code: 0, stdout: "https://github.com/acme/widgets/issues/77\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const ctx: GhContext = { cwd: "/repo", repo: "acme/widgets", exec };

    await comment(ctx, 1, LEAK_TEXT);
    await postClaimComment(ctx, 1, `<!-- afk:claim v1 worker=w kind=claim runner=codex -->\n${LEAK_TEXT}`);
    await editBody(ctx, 1, LEAK_TEXT);
    await createIssue(ctx, { title: `Issue ${LEAK_ENV_VALUE}`, body: LEAK_TEXT, labels: ["ready-for-agent"] });
    await updateMainRedRepairIssue(ctx, 1, { title: `Repair ${LEAK_ENV_VALUE}`, body: LEAK_TEXT, labels: ["ready-for-human"] });

    const joined = calls.flatMap((c) => c.args).join("\n");
    expectScrubbed(joined);
    expect(joined).toContain("<!-- afk:claim v1 worker=w kind=claim runner=codex -->");
  });

  it("scrubs PR review summaries, inline comments, and fallback PR comments", async () => {
    withSyntheticEnv();
    const postedBodies: string[] = [];
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args): Promise<ExecOutput> => {
      calls.push([...args]);
      const inputIndex = args.indexOf("--input");
      if (inputIndex >= 0) {
        const raw = readFileSync(String(args[inputIndex + 1]), "utf8");
        postedBodies.push(raw);
      }
      const bodyIndex = args.indexOf("--body");
      if (bodyIndex >= 0) postedBodies.push(String(args[bodyIndex + 1]));
      return { code: 0, stdout: "", stderr: "" };
    };
    const gh = buildReviewGh({ cwd: "/repo", repo: "acme/widgets", exec });

    await gh.postReview(9, {
      summary: LEAK_TEXT,
      comments: [{ path: "src/a.ts", line: 1, body: LEAK_TEXT }],
    });
    await gh.comment(9, LEAK_TEXT);

    expectScrubbed(postedBodies.join("\n"));
    expect(calls.some((args) => args.includes("repos/acme/widgets/pulls/9/reviews"))).toBe(true);
  });

  it("scrubs PR create title and body in the merge seam", async () => {
    withSyntheticEnv();
    const calls: string[][] = [];
    const exec: Exec = async (args) => {
      calls.push([...args]);
      if (args.includes("list")) {
        const previousCreates = calls.filter((call) => call.includes("create")).length;
        return { code: 0, stdout: previousCreates > 0 ? "88\n" : "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    await landPr(exec, {
      repo: "acme/widgets",
      gitRepo: "/repo",
      remote: "origin",
      branch: "afk/test",
      target: "main",
      n: 1365,
      title: LEAK_TEXT,
      mergeQueue: true,
    });

    const create = calls.find((args) => args.includes("create"));
    expect(create).toBeTruthy();
    expectScrubbed(create!.join("\n"));
    expect(create!.join("\n")).toContain("Closes #1365");
  });
});
