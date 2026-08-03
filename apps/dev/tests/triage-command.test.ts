import { describe, expect, it } from "vitest";
import { runTriage } from "../src/commands/triage.js";
import { ACCEPTANCE_CRITERIA_RECIPE_COMMENT_MARKER } from "../src/core/executable-acceptance.js";
import type { GhContext } from "../src/runtime/gh.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";
import type { TrustPolicy } from "../src/core/trust-gate.js";
import { readsIssue, restIssueBody } from "./support/gh-rest-fixtures.js";

// End-to-end coverage of the trust-gated `dev triage` flow against a FAKE `gh`
// (#751 acceptance #4): trusted ⇒ auto, untrusted ⇒ no-op until summon,
// summon ⇒ triage runs. The fake routes each `gh` invocation by its argv so a
// single recorder can answer the author/labels reads AND record the writes.

interface FakeGh {
  exec: ExecFn;
  calls: { cmd: string; args: string[] }[];
  edits: { remove: string[]; add: string[] }[];
  comments: string[];
  commentEdits: { id: number; body: string }[];
  closes: number[];
}

interface FakeComment {
  id?: number;
  body: string;
  authorAssociation?: string;
  isBot?: boolean;
}

function fakeGh(
  author: string,
  labels: string[] = ["needs-triage"],
  body = `## Acceptance criteria

- [ ] Running \`pnpm --filter @reddb-io/dev test\` passes.
`,
  existingComments: Array<string | FakeComment> = [],
): FakeGh {
  const calls: { cmd: string; args: string[] }[] = [];
  const edits: { remove: string[]; add: string[] }[] = [];
  const comments: string[] = [];
  const commentEdits: { id: number; body: string }[] = [];
  const closes: number[] = [];

  const ok = (stdout = ""): ExecOutput => ({ code: 0, stdout, stderr: "" });

  const exec: ExecFn = (cmd, argv) => {
    const args = [...argv];
    calls.push({ cmd, args });
    const has = (s: string) => args.includes(s);

    if (has("view") && has("--json") && args[args.indexOf("--json") + 1] === "author") {
      return Promise.resolve(ok(JSON.stringify({ author: { login: author } })));
    }
    // The label and body reads name one issue, so they arrive over REST (#3094).
    // The author read stays on gh's own command: REST spells a bot login
    // `<name>[bot]` where gh normalizes it to `app/<name>`, a difference the
    // trust check would read as a different actor.
    if (readsIssue(args)) {
      return Promise.resolve(ok(JSON.stringify(restIssueBody({ labels, body }))));
    }
    if (has("view") && has("--json") && args[args.indexOf("--json") + 1] === "comments") {
      return Promise.resolve(ok(JSON.stringify({
        comments: existingComments.map((comment) => ({
          body: typeof comment === "string" ? comment : comment.body,
          author: { login: "red-skills-bot", is_bot: true },
          authorAssociation: "MEMBER",
          createdAt: "2026-07-22T00:00:00Z",
        })),
      })));
    }
    if (has("api") && has("--paginate") && args.some((arg) => arg.includes("issues/") && arg.endsWith("/comments"))) {
      return Promise.resolve(ok(existingComments.map((comment, index) => {
        const item: FakeComment = typeof comment === "string" ? { body: comment } : comment;
        return JSON.stringify({
          id: item.id ?? index + 1,
          body: item.body,
          author: { login: "red-skills-bot", is_bot: item.isBot ?? true },
          authorAssociation: item.authorAssociation ?? "MEMBER",
          createdAt: "2026-07-22T00:00:00Z",
        });
      }).join("\n")));
    }
    if (has("api") && has("PATCH") && args.some((arg) => arg.includes("issues/comments/"))) {
      const idArg = args.find((arg) => arg.includes("issues/comments/")) ?? "";
      const id = Number(idArg.match(/issues\/comments\/(\d+)/)?.[1] ?? 0);
      const bodyArg = args.find((arg) => arg.startsWith("body=")) ?? "body=";
      commentEdits.push({ id, body: bodyArg.slice("body=".length) });
      return Promise.resolve(ok());
    }
    if (has("edit")) {
      const remove: string[] = [];
      const add: string[] = [];
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--remove-label") remove.push(args[++i]!);
        if (args[i] === "--add-label") add.push(args[++i]!);
      }
      edits.push({ remove, add });
      return Promise.resolve(ok());
    }
    if (has("comment")) {
      comments.push(args[args.indexOf("--body") + 1] ?? "");
      return Promise.resolve(ok());
    }
    if (has("close")) {
      closes.push(Number(args[args.indexOf("close") + 1]));
      return Promise.resolve(ok());
    }
    // label create (ensureLabel) and anything else: succeed quietly.
    return Promise.resolve(ok());
  };

  return { exec, calls, edits, comments, commentEdits, closes };
}

const strict: TrustPolicy = { enabled: true, allowlist: ["alice"] };
const permissive: TrustPolicy = { enabled: false, allowlist: [] };

function ctxFor(fake: FakeGh): GhContext {
  return { cwd: "/r", repo: "acme/widgets", exec: fake.exec };
}

describe("runTriage — trusted author auto-triages", () => {
  it("applies the decided transition with no summon", async () => {
    const fake = fakeGh("alice");
    const outcome = await runTriage(ctxFor(fake), strict, {
      issue: 42,
      decision: "ready-for-agent",
      summon: false,
    });

    expect(outcome.action).toBe("auto-triage");
    expect(outcome.applied?.decision).toBe("ready-for-agent");
    expect(fake.edits).toEqual([{ remove: ["needs-triage"], add: ["ready-for-agent"] }]);
    expect(fake.comments[0]).toContain("This was generated by AI during triage");
    expect(fake.closes).toEqual([]);
  });

  it("auto-triages everything under a permissive policy", async () => {
    const fake = fakeGh("a-total-stranger");
    const outcome = await runTriage(ctxFor(fake), permissive, {
      issue: 7,
      decision: "needs-info",
      summon: false,
    });
    expect(outcome.action).toBe("auto-triage");
    expect(fake.edits).toEqual([{ remove: ["needs-triage"], add: ["needs-info"] }]);
  });

  it("wontfix closes the issue after the transition", async () => {
    const fake = fakeGh("alice");
    await runTriage(ctxFor(fake), strict, { issue: 9, decision: "wontfix", summon: false });
    expect(fake.edits).toEqual([{ remove: ["needs-triage"], add: ["wontfix"] }]);
    expect(fake.closes).toEqual([9]);
  });
});

describe("runTriage — ready-for-agent acceptance criteria lint", () => {
  it("routes an AC-less executable candidate back to needs-triage with one recipe comment", async () => {
    const fake = fakeGh("alice", ["ready-for-agent"], "## What to build\n\nMake it better.\n");
    const outcome = await runTriage(ctxFor(fake), strict, {
      issue: 77,
      decision: "ready-for-agent",
      summon: false,
    });

    expect(outcome.action).toBe("acceptance-lint-failed");
    expect(fake.edits).toEqual([{ remove: ["ready-for-agent"], add: ["needs-triage"] }]);
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]).toContain(ACCEPTANCE_CRITERIA_RECIPE_COMMENT_MARKER);
    expect(fake.comments[0]).toContain("missing acceptance-criteria section");
    expect(fake.closes).toEqual([]);
  });

  it("does not post a duplicate recipe comment when a trusted lint marker already exists", async () => {
    const fake = fakeGh("alice", ["ready-for-agent"], "## What to build\n\nMake it better.\n", [
      `> *This was generated by AI during triage.*\n\n${ACCEPTANCE_CRITERIA_RECIPE_COMMENT_MARKER}`,
    ]);
    const outcome = await runTriage(ctxFor(fake), strict, {
      issue: 78,
      decision: "ready-for-agent",
      summon: false,
    });

    expect(outcome.action).toBe("acceptance-lint-failed");
    expect(fake.edits).toEqual([{ remove: ["ready-for-agent"], add: ["needs-triage"] }]);
    expect(fake.comments).toEqual([]);
    expect(fake.commentEdits).toHaveLength(1);
    expect(fake.commentEdits[0]?.body).toContain("missing acceptance-criteria section");
  });

  it("updates the owned recipe comment when the lint reason changes", async () => {
    const fake = fakeGh("alice", ["ready-for-agent"], `## Acceptance criteria

- [ ] The UI renders nicely.
`, [
      {
        id: 456,
        body: `> *This was generated by AI during triage.*\n\n${ACCEPTANCE_CRITERIA_RECIPE_COMMENT_MARKER}\n\nMissing: missing acceptance-criteria section.`,
        authorAssociation: "MEMBER",
        isBot: false,
      },
    ]);
    const outcome = await runTriage(ctxFor(fake), strict, {
      issue: 79,
      decision: "ready-for-agent",
      summon: false,
    });

    expect(outcome.action).toBe("acceptance-lint-failed");
    expect(fake.comments).toEqual([]);
    expect(fake.commentEdits).toHaveLength(1);
    expect(fake.commentEdits[0]).toMatchObject({ id: 456 });
    expect(fake.commentEdits[0]?.body).toContain("The UI renders nicely.");
  });

  it("does not trust a copied recipe marker from a dubious commenter", async () => {
    const fake = fakeGh("alice", ["ready-for-agent"], "## What to build\n\nMake it better.\n", [
      {
        id: 999,
        body: ACCEPTANCE_CRITERIA_RECIPE_COMMENT_MARKER,
        authorAssociation: "CONTRIBUTOR",
        isBot: false,
      },
    ]);
    const outcome = await runTriage(ctxFor(fake), strict, {
      issue: 80,
      decision: "ready-for-agent",
      summon: false,
    });

    expect(outcome.action).toBe("acceptance-lint-failed");
    expect(fake.commentEdits).toEqual([]);
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]).toContain("missing acceptance-criteria section");
  });

  it("holds without writes when the issue body cannot be read", async () => {
    const fake = fakeGh("alice", ["ready-for-agent"]);
    const failing: GhContext = {
      cwd: "/r",
      repo: "acme/widgets",
      exec: (cmd, argv) => {
        const args = [...argv];
        // The body read is one issue by number, so it addresses REST (#3094) —
        // the same path the label read uses, which is why this fake refuses the
        // whole single-object read rather than one `--json` selection of it.
        if (readsIssue(args)) {
          return Promise.resolve({ code: 1, stdout: "", stderr: "network unavailable" });
        }
        return fake.exec(cmd, argv, { cwd: "/r" });
      },
    };
    const outcome = await runTriage(failing, strict, {
      issue: 81,
      decision: "ready-for-agent",
      summon: false,
    });

    expect(outcome.action).toBe("acceptance-lint-held");
    expect(fake.edits).toEqual([]);
    expect(fake.comments).toEqual([]);
    expect(fake.commentEdits).toEqual([]);
  });

  it("does not post a recipe comment when existing comments cannot be read", async () => {
    const fake = fakeGh("alice", ["ready-for-agent"], "## What to build\n\nMake it better.\n");
    const failing: GhContext = {
      cwd: "/r",
      repo: "acme/widgets",
      exec: (cmd, argv) => {
        const args = [...argv];
        if (args.includes("api") && args.includes("--paginate")) {
          return Promise.resolve({ code: 1, stdout: "", stderr: "comments unavailable" });
        }
        return fake.exec(cmd, argv, { cwd: "/r" });
      },
    };
    const outcome = await runTriage(failing, strict, {
      issue: 82,
      decision: "ready-for-agent",
      summon: false,
    });

    expect(outcome.action).toBe("acceptance-lint-failed");
    expect(fake.edits).toEqual([{ remove: ["ready-for-agent"], add: ["needs-triage"] }]);
    expect(fake.comments).toEqual([]);
  });
});

describe("runTriage — untrusted author is a NO-OP until summon", () => {
  it("does not edit labels, comment, or close when untrusted and unsummoned", async () => {
    const fake = fakeGh("stranger");
    const outcome = await runTriage(ctxFor(fake), strict, {
      issue: 99,
      decision: "ready-for-agent",
      summon: false,
    });

    expect(outcome.action).toBe("hold-for-summon");
    expect(outcome.reason).toContain("untrusted author 'stranger'");
    expect(fake.edits).toEqual([]);
    expect(fake.comments).toEqual([]);
    expect(fake.closes).toEqual([]);
  });

  it("an unknown author (gh read failed) is also held", async () => {
    const fake = fakeGh("");
    // Force the author read to fail entirely.
    const failing: GhContext = {
      cwd: "/r",
      repo: "acme/widgets",
      exec: (cmd, argv) => {
        const args = [...argv];
        if (args.includes("--json") && args[args.indexOf("--json") + 1] === "author") {
          return Promise.resolve({ code: 1, stdout: "", stderr: "not found" });
        }
        return fake.exec(cmd, argv, { cwd: "/r" });
      },
    };
    const outcome = await runTriage(failing, strict, {
      issue: 5,
      decision: "ready-for-agent",
      summon: false,
    });
    expect(outcome.action).toBe("hold-for-summon");
    expect(fake.edits).toEqual([]);
  });
});

describe("runTriage — maintainer summon releases an untrusted author's issue", () => {
  it("the --summon flag releases the issue and applies the transition", async () => {
    const fake = fakeGh("stranger");
    const outcome = await runTriage(ctxFor(fake), strict, {
      issue: 99,
      decision: "ready-for-agent",
      summon: true,
    });

    expect(outcome.action).toBe("auto-triage");
    expect(fake.edits).toEqual([{ remove: ["needs-triage"], add: ["ready-for-agent"] }]);
    expect(fake.comments[0]).toContain("released by maintainer summon");
  });

  it("the triage:summon label is also a summon channel and is shed on apply", async () => {
    const fake = fakeGh("stranger", ["needs-triage", "triage:summon"]);
    const outcome = await runTriage(ctxFor(fake), strict, {
      issue: 100,
      decision: "ready-for-human",
      summon: false,
    });

    expect(outcome.action).toBe("auto-triage");
    expect(fake.edits).toEqual([
      { remove: ["needs-triage", "triage:summon"], add: ["ready-for-human"] },
    ]);
  });
});
