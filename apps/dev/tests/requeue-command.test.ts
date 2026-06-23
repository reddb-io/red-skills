import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { formatCurrentBlocker } from "../src/core/blocker-state.js";
import { isRequeueComplete } from "../src/core/requeue.js";
import { requeueCommand, type RequeueGh } from "../src/commands/requeue.js";

function capture(): { stream: Writable; text: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

function fakeGh(state: { state: string; body: string; labels: string[] }) {
  const calls = { editBody: 0, editLabels: 0, comment: 0 };
  let lastRemove: string[] = [];
  let lastAdd: string[] = [];
  const gh: RequeueGh = {
    async view() {
      return state;
    },
    async editBody(_issue, body) {
      calls.editBody += 1;
      state.body = body;
    },
    async editLabels(_issue, remove, add) {
      calls.editLabels += 1;
      lastRemove = remove;
      lastAdd = add;
      state.labels = [...state.labels.filter((l) => !remove.includes(l)), ...add];
    },
    async comment() {
      calls.comment += 1;
    },
  };
  return { gh, calls, get state() { return state; }, get lastRemove() { return lastRemove; }, get lastAdd() { return lastAdd; } };
}

const validationBlocker = {
  status: "blocked" as const,
  kind: "validation",
  summary: "Package gate failed.",
  next: "Human must decide whether to retry.",
};

const parkedBody = `## Summary\nDo it.\n\n## Current blocker\n\n${formatCurrentBlocker(validationBlocker)}\n`;

describe("requeue command", () => {
  it("applies the full transition so a label flip alone is never the requeue", async () => {
    const { gh, calls, state, lastRemove, lastAdd } = fakeGh({
      state: "OPEN",
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation"],
    });
    const { stream, text } = capture();

    const code = await requeueCommand(["#42", "--guidance", "Gate flake fixed."], "/tmp", stream, gh);

    expect(code).toBe(0);
    expect(calls.editBody).toBe(1); // body rewritten, not a manual edit
    expect(calls.comment).toBe(1); // guidance recorded
    expect(calls.editLabels).toBe(1);
    // After the transition the issue is a COMPLETE requeue — no active blocker left.
    expect(isRequeueComplete(state.body, ["ready-for-agent"])).toBe(true);
    expect(text()).toContain("Requeue #42");
  });

  it("never mutates and reports a no-op when the issue is not parked", async () => {
    const { gh, calls } = fakeGh({ state: "OPEN", body: "## Summary\nNothing.\n", labels: ["ready-for-agent"] });
    const { stream, text } = capture();

    const code = await requeueCommand(["42"], "/tmp", stream, gh);

    expect(code).toBe(0);
    expect(calls.editBody + calls.editLabels + calls.comment).toBe(0);
    expect(text()).toContain("no-op");
  });

  it("dry-run prints the plan without mutating", async () => {
    const { gh, calls } = fakeGh({
      state: "OPEN",
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation"],
    });
    const { stream, text } = capture();

    const code = await requeueCommand(["#42", "--dry-run"], "/tmp", stream, gh);

    expect(code).toBe(0);
    expect(calls.editBody + calls.editLabels + calls.comment).toBe(0);
    expect(text()).toContain("dry-run");
  });

  it("refuses a closed issue", async () => {
    const { gh, calls } = fakeGh({ state: "CLOSED", body: parkedBody, labels: ["blocked:spec"] });
    const { stream } = capture();

    const code = await requeueCommand(["#42"], "/tmp", stream, gh);

    expect(code).toBe(1);
    expect(calls.editBody + calls.editLabels + calls.comment).toBe(0);
  });

  it("rejects a missing issue number", async () => {
    const { gh } = fakeGh({ state: "OPEN", body: "", labels: [] });
    const { stream } = capture();
    expect(await requeueCommand([], "/tmp", stream, gh)).toBe(2);
  });
});
