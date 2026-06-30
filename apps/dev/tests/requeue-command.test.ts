import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { formatCurrentBlocker } from "../src/core/blocker-state.js";
import { isRequeueComplete } from "../src/core/requeue.js";
import { requeueCommand, type RequeueGh, type RequeueAdoptRunner } from "../src/commands/requeue.js";

function capture(): { stream: Writable; text: () => string; stderr: () => string } {
  let buf = "";
  let errBuf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  // stderr goes to process.stderr; we capture it via mock below
  return { stream, text: () => buf, stderr: () => errBuf };
}

function captureStderr(): { restore: () => void; text: () => string } {
  let buf = "";
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  return { restore: () => { process.stderr.write = orig; }, text: () => buf };
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

const specBlocker = {
  status: "blocked" as const,
  kind: "spec",
  summary: "Spec is ambiguous.",
  next: "Human must clarify before work proceeds.",
};

const parkedBody = `## Summary\nDo it.\n\n## Current blocker\n\n${formatCurrentBlocker(validationBlocker)}\n`;
const specBodyMismatch = `## Summary\nDo it.\n\n## Current blocker\n\n${formatCurrentBlocker(specBlocker)}\n`;

describe("requeue command — happy path", () => {
  it("applies the full transition so a label flip alone is never the requeue", async () => {
    const { gh, calls, state } = fakeGh({
      state: "OPEN",
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation"],
    });
    const { stream, text } = capture();

    const code = await requeueCommand(["#42", "--guidance", "Gate flake fixed."], "/tmp", stream, gh);

    expect(code).toBe(0);
    expect(calls.editBody).toBe(1);
    expect(calls.comment).toBe(1);
    expect(calls.editLabels).toBe(1);
    expect(isRequeueComplete(state.body, ["ready-for-agent"])).toBe(true);
    expect(text()).toContain("Requeue #42");
  });

  it("never mutates and reports a no-op when the issue is not parked", async () => {
    const { gh, calls } = fakeGh({ state: "OPEN", body: "## Summary\nNothing.\n", labels: ["ready-for-agent"] });
    const { stream, text } = capture();

    const code = await requeueCommand(["42", "--guidance", "Retry."], "/tmp", stream, gh);

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

    const code = await requeueCommand(["#42", "--guidance", "Gate flake fixed.", "--dry-run"], "/tmp", stream, gh);

    expect(code).toBe(0);
    expect(calls.editBody + calls.editLabels + calls.comment).toBe(0);
    expect(text()).toContain("dry-run");
  });

  it("refuses a closed issue", async () => {
    const { gh, calls } = fakeGh({ state: "CLOSED", body: parkedBody, labels: ["blocked:validation"] });
    const { stream } = capture();

    const code = await requeueCommand(["#42", "--guidance", "Fixed."], "/tmp", stream, gh);

    expect(code).toBe(1);
    expect(calls.editBody + calls.editLabels + calls.comment).toBe(0);
  });
});

describe("requeue command — usage errors (exit 2)", () => {
  it("rejects a missing issue number", async () => {
    const { gh } = fakeGh({ state: "OPEN", body: "", labels: [] });
    const { stream } = capture();
    const err = captureStderr();
    const code = await requeueCommand([], "/tmp", stream, gh);
    err.restore();
    expect(code).toBe(2);
  });

  it("rejects missing --guidance before reading the issue", async () => {
    const { gh, calls } = fakeGh({ state: "OPEN", body: parkedBody, labels: ["blocked:validation"] });
    const { stream } = capture();
    const err = captureStderr();

    const code = await requeueCommand(["#42"], "/tmp", stream, gh);
    err.restore();

    expect(code).toBe(2);
    expect(err.text()).toContain("--guidance");
    expect(calls.editBody + calls.editLabels + calls.comment).toBe(0);
  });

  it("rejects an empty --guidance string", async () => {
    const { gh, calls } = fakeGh({ state: "OPEN", body: parkedBody, labels: ["blocked:validation"] });
    const { stream } = capture();
    const err = captureStderr();

    const code = await requeueCommand(["#42", "--guidance", "   "], "/tmp", stream, gh);
    err.restore();

    expect(code).toBe(2);
    expect(calls.editBody + calls.editLabels + calls.comment).toBe(0);
  });
});

describe("requeue command — /hitl refusals (exit 1, no mutation)", () => {
  it("refuses mixed blocked:* labels and exits 1 without mutation", async () => {
    const { gh, calls } = fakeGh({
      state: "OPEN",
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation", "blocked:spec"],
    });
    const { stream } = capture();
    const err = captureStderr();

    const code = await requeueCommand(["#42", "--guidance", "Retry."], "/tmp", stream, gh);
    err.restore();

    expect(code).toBe(1);
    expect(err.text()).toContain("refused");
    expect(calls.editBody + calls.editLabels + calls.comment).toBe(0);
  });

  it("refuses a label/body kind mismatch (blocked:validation label, spec blocker in body) and exits 1", async () => {
    const { gh, calls } = fakeGh({
      state: "OPEN",
      body: specBodyMismatch,
      labels: ["ready-for-human", "blocked:validation"],
    });
    const { stream } = capture();
    const err = captureStderr();

    const code = await requeueCommand(["#42", "--guidance", "Fixed."], "/tmp", stream, gh);
    err.restore();

    expect(code).toBe(1);
    expect(err.text()).toContain("refused");
    expect(calls.editBody + calls.editLabels + calls.comment).toBe(0);
  });

  it("refuses an unsupported blocked:decision label and exits 1", async () => {
    const { gh, calls } = fakeGh({
      state: "OPEN",
      body: "## Summary\nNeeds a decision.\n",
      labels: ["ready-for-human", "blocked:decision"],
    });
    const { stream } = capture();
    const err = captureStderr();

    const code = await requeueCommand(["#42", "--guidance", "Decision made."], "/tmp", stream, gh);
    err.restore();

    expect(code).toBe(1);
    expect(err.text()).toContain("refused");
    expect(calls.editBody + calls.editLabels + calls.comment).toBe(0);
  });
});

// ---------- ADR 0081 — adopt mode (--adopt-branch) ----------

describe("requeue command — adopt mode (--adopt-branch)", () => {
  it("requires --guidance even in adopt mode", async () => {
    const { gh } = fakeGh({ state: "OPEN", body: "## Summary\nFoo.\n", labels: [] });
    const { stream } = capture();
    const err = captureStderr();

    const code = await requeueCommand(["#42", "--adopt-branch", "my-branch"], "/tmp", stream, gh);
    err.restore();

    expect(code).toBe(2);
    expect(err.text()).toContain("--guidance");
  });

  it("applies requeue transition then calls adopt runner for a parked issue", async () => {
    const { gh, calls } = fakeGh({
      state: "OPEN",
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation"],
    });
    const { stream, text } = capture();
    let adoptCalled = false;
    const runner: RequeueAdoptRunner = async () => { adoptCalled = true; return "landed"; };

    const code = await requeueCommand(
      ["#42", "--guidance", "Gate flake fixed.", "--adopt-branch", "my-branch"],
      "/tmp", stream, gh, runner,
    );

    expect(code).toBe(0);
    expect(calls.editBody).toBe(1);
    expect(calls.editLabels).toBe(1);
    expect(adoptCalled).toBe(true);
    expect(text()).toContain("validated and landed");
  });

  it("calls adopt runner even when issue is not parked (fresh issue, no blockers)", async () => {
    const { gh, calls } = fakeGh({ state: "OPEN", body: "## Summary\nFoo.\n", labels: [] });
    const { stream, text } = capture();
    let adoptCalled = false;
    const runner: RequeueAdoptRunner = async () => { adoptCalled = true; return "landed"; };

    const code = await requeueCommand(
      ["#42", "--guidance", "Adopt hand-done branch.", "--adopt-branch", "my-branch"],
      "/tmp", stream, gh, runner,
    );

    expect(code).toBe(0);
    // No transition applied (issue was not parked)
    expect(calls.editBody + calls.editLabels + calls.comment).toBe(0);
    expect(adoptCalled).toBe(true);
    expect(text()).toContain("validated and landed");
  });

  it("exits 1 when adopt runner returns parked (gate failed)", async () => {
    const { gh } = fakeGh({ state: "OPEN", body: "## Summary\nFoo.\n", labels: [] });
    const { stream } = capture();
    const err = captureStderr();
    const runner: RequeueAdoptRunner = async () => "parked";

    const code = await requeueCommand(
      ["#42", "--guidance", "Fix tests.", "--adopt-branch", "broken-branch"],
      "/tmp", stream, gh, runner,
    );
    err.restore();

    expect(code).toBe(1);
    expect(err.text()).toContain("gate failed");
  });

  it("exits 0 with skip note when adopt runner returns skipped", async () => {
    const { gh } = fakeGh({ state: "OPEN", body: "## Summary\nFoo.\n", labels: [] });
    const { stream, text } = capture();
    const runner: RequeueAdoptRunner = async () => "skipped";

    const code = await requeueCommand(
      ["#42", "--guidance", "Adopt.", "--adopt-branch", "empty-branch"],
      "/tmp", stream, gh, runner,
    );

    expect(code).toBe(0);
    expect(text()).toContain("skipped");
  });

  it("does not call adopt runner when issue has HITL-refuse (mixed blockers)", async () => {
    const { gh } = fakeGh({
      state: "OPEN",
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation", "blocked:spec"],
    });
    const { stream } = capture();
    const err = captureStderr();
    let adoptCalled = false;
    const runner: RequeueAdoptRunner = async () => { adoptCalled = true; return "landed"; };

    const code = await requeueCommand(
      ["#42", "--guidance", "Fixed.", "--adopt-branch", "my-branch"],
      "/tmp", stream, gh, runner,
    );
    err.restore();

    expect(code).toBe(1);
    expect(adoptCalled).toBe(false);
  });

  it("dry-run with --adopt-branch does not call adopt runner", async () => {
    const { gh } = fakeGh({ state: "OPEN", body: "## Summary\nFoo.\n", labels: [] });
    const { stream, text } = capture();
    let adoptCalled = false;
    const runner: RequeueAdoptRunner = async () => { adoptCalled = true; return "landed"; };

    const code = await requeueCommand(
      ["#42", "--guidance", "Adopt.", "--adopt-branch", "my-branch", "--dry-run"],
      "/tmp", stream, gh, runner,
    );

    expect(code).toBe(0);
    expect(adoptCalled).toBe(false);
    expect(text()).toContain("dry-run");
    expect(text()).toContain("adopt-branch=my-branch");
  });
});
