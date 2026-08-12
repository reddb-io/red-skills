import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  cmdAct,
  enforceHitlCardActionRate,
  type HitlCardExec,
} from "../src/commands/hitl-card.js";
import {
  HITL_CARD_ACTION_MARKER,
  HITL_CARD_STAND_DOWN_MARKER,
} from "../src/core/hitl-card.js";

function capture(): { stream: Writable; text: () => string } {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    text: () => value,
  };
}

describe("hitl-card command runaway guards", () => {
  it("drops a bot-authored /requeue reply without making a GitHub call", async () => {
    let calls = 0;
    const exec: HitlCardExec = async () => {
      calls += 1;
      return { code: 0, stdout: "", stderr: "" };
    };
    const output = capture();

    await expect(cmdAct(
      exec,
      "reddb-io/red-skills",
      2443,
      "/requeue Cannot requeue: blocked:infra is not supported",
      "github-actions[bot]",
      "Bot",
      ["maintainer"],
      [{ login: "github-actions[bot]", type: "Bot" }],
      "/tmp",
      output.stream,
    )).resolves.toBe(0);

    expect(calls).toBe(0);
    expect(output.text()).toContain("ignored automation-authored comment");
  });

  it("drops an unallowlisted PAT-backed User refusal without making a GitHub call", async () => {
    let calls = 0;
    const exec: HitlCardExec = async () => {
      calls += 1;
      return { code: 0, stdout: "", stderr: "" };
    };
    const output = capture();

    await expect(cmdAct(
      exec,
      "reddb-io/red-skills",
      2443,
      "/requeue Cannot requeue: blocked:infra is not supported",
      "release-maintainer",
      "User",
      ["maintainer"],
      [{ login: "github-actions[bot]", type: "Bot" }],
      "/tmp",
      output.stream,
    )).resolves.toBe(0);

    expect(calls).toBe(0);
    expect(output.text()).toContain("ignored automation-authored comment");
  });

  it("posts exactly one stand-down comment once the issue reaches its action cap", async () => {
    const posted: string[] = [];
    const exec: HitlCardExec = async (args) => {
      const bodyIndex = args.indexOf("--body");
      const restBody = args.find((arg) => arg.startsWith("body="));
      if (bodyIndex !== -1) posted.push(args[bodyIndex + 1] ?? "");
      else if (restBody !== undefined) posted.push(restBody.slice("body=".length));
      return { code: 0, stdout: "", stderr: "" };
    };
    const output = capture();
    const now = new Date("2026-07-22T08:00:00Z");
    const comments = [0, 1, 2].map((minute) => ({
      body: `${HITL_CARD_ACTION_MARKER}\naction ${minute}`,
      createdAt: `2026-07-22T07:5${minute}:00Z`,
      author: "github-actions[bot]",
      authorType: "Bot",
    }));

    await expect(enforceHitlCardActionRate(
      exec,
      "reddb-io/red-skills",
      2443,
      comments,
      output.stream,
      now,
      [{ login: "github-actions[bot]", type: "Bot" }],
    )).resolves.toBe(true);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(HITL_CARD_STAND_DOWN_MARKER);
    expect(posted[0]).toContain("loop suspected");
    expect(posted[0]).toContain("standing down");

    comments.push({
      body: posted[0]!,
      createdAt: "2026-07-22T07:59:00Z",
      author: "github-actions[bot]",
      authorType: "Bot",
    });
    await enforceHitlCardActionRate(
      exec,
      "reddb-io/red-skills",
      2443,
      comments,
      output.stream,
      now,
      [{ login: "github-actions[bot]", type: "Bot" }],
    );
    expect(posted).toHaveLength(1);
  });
});
