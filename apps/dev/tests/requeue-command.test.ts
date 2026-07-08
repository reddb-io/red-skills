import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { formatCurrentBlocker } from "../src/core/blocker-state.js";
import { renderClaimComment } from "../src/core/claim.js";
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
  const calls = { editBody: 0, editLabels: 0, comment: 0, postClaim: 0 };
  let lastRemove: string[] = [];
  let lastAdd: string[] = [];
  const postedClaims: string[] = [];
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
    async listClaims() {
      return [];
    },
    async postClaim(_issue, body) {
      calls.postClaim += 1;
      postedClaims.push(body);
    },
  };
  return { gh, calls, postedClaims, get state() { return state; }, get lastRemove() { return lastRemove; }, get lastAdd() { return lastAdd; } };
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

const sensitivePathBlocker = {
  status: "blocked" as const,
  kind: "sensitive-path",
  summary: "Diff touches .github/workflows/ci.yml.",
  next: "Human must review the protected diff before it can land.",
};

const parkedBody = `## Summary\nDo it.\n\n## Current blocker\n\n${formatCurrentBlocker(validationBlocker)}\n`;
const specBodyMismatch = `## Summary\nDo it.\n\n## Current blocker\n\n${formatCurrentBlocker(specBlocker)}\n`;
const sensitivePathBody = `## Summary\nDo it.\n\n## Current blocker\n\n${formatCurrentBlocker(sensitivePathBlocker)}\n`;

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

  it("concedes active claim markers before requeueing", async () => {
    const { gh, calls, postedClaims } = fakeGh({
      state: "OPEN",
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation"],
    });
    gh.listClaims = async () => [
      { id: 10, body: renderClaimComment({ worker: "host:wOLD" }) },
      { id: 20, body: renderClaimComment({ worker: "host:wDONE" }) },
      { id: 30, body: renderClaimComment({ worker: "host:wDONE" }, "concede") },
    ];
    const { stream } = capture();

    const code = await requeueCommand(["#42", "--guidance", "Retry is now safe."], "/tmp", stream, gh);

    expect(code).toBe(0);
    expect(calls.postClaim).toBe(1);
    expect(postedClaims[0]).toContain("worker=host:wOLD");
    expect(postedClaims[0]).toContain("kind=concede");
    expect(calls.comment).toBe(2);
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

  it("bare requeue of a blocked:sensitive-path park still refuses → /hitl (exit 1, no adopt)", async () => {
    const { gh, calls } = fakeGh({
      state: "OPEN",
      body: sensitivePathBody,
      labels: ["ready-for-human", "blocked:sensitive-path"],
    });
    const { stream } = capture();
    const err = captureStderr();

    const code = await requeueCommand(["#42", "--guidance", "Reviewed the CI diff."], "/tmp", stream, gh);
    err.restore();

    expect(code).toBe(1);
    expect(err.text()).toContain("refused");
    expect(err.text()).toMatch(/adopt-branch/);
    expect(calls.editBody + calls.editLabels + calls.comment).toBe(0);
  });

  it("--adopt-branch clears a blocked:sensitive-path park, flags the guard bypass, and lands", async () => {
    const { gh, calls, state } = fakeGh({
      state: "OPEN",
      body: sensitivePathBody,
      labels: ["ready-for-human", "blocked:sensitive-path"],
    });
    const { stream, text } = capture();
    let adoptApproved: boolean | undefined;
    const runner: RequeueAdoptRunner = async (_issue, _branch, issueData) => {
      adoptApproved = issueData.sensitivePathApproved;
      return "landed";
    };

    const code = await requeueCommand(
      ["#42", "--guidance", "Maintainer reviewed the workflow diff; land it.", "--adopt-branch", "afk/w/9-fix"],
      "/tmp", stream, gh, runner,
    );

    expect(code).toBe(0);
    // Transition applied: blocker cleared, sensitive-path label dropped.
    expect(calls.editBody).toBe(1);
    expect(calls.editLabels).toBe(1);
    expect(state.labels).not.toContain("blocked:sensitive-path");
    // #1307: `ready-for-agent` is WITHHELD for the adopt gate — the Ticket must
    // not be claimable while the gate runs, and a landed gate closes it anyway.
    expect(state.labels).not.toContain("ready-for-agent");
    // Guard bypass flag threaded to the adopt runner.
    expect(adoptApproved).toBe(true);
    // Audit comment posted in addition to the directive comment (never silent).
    expect(calls.comment).toBeGreaterThanOrEqual(2);
    expect(text()).toContain("validated and landed");
  });

  it("a NON-sensitive adopt does not set the guard-bypass flag (defaults false)", async () => {
    const { gh } = fakeGh({
      state: "OPEN",
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation"],
    });
    const { stream } = capture();
    let adoptApproved: boolean | undefined = true;
    const runner: RequeueAdoptRunner = async (_issue, _branch, issueData) => {
      adoptApproved = issueData.sensitivePathApproved;
      return "landed";
    };

    const code = await requeueCommand(
      ["#42", "--guidance", "Gate flake fixed.", "--adopt-branch", "my-branch"],
      "/tmp", stream, gh, runner,
    );

    expect(code).toBe(0);
    expect(adoptApproved).toBe(false);
  });

  // ---------- #1307 — close the concurrent-claim window during the adopt gate ----------

  it("withholds ready-for-agent while the adopt gate runs so the Ticket is not claimable mid-land (#1307)", async () => {
    const { gh, state } = fakeGh({
      state: "OPEN",
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation"],
    });
    const { stream } = capture();
    let labelsDuringGate: string[] = [];
    const runner: RequeueAdoptRunner = async () => {
      labelsDuringGate = [...state.labels];
      return "landed";
    };

    const code = await requeueCommand(
      ["#42", "--guidance", "Gate flake fixed.", "--adopt-branch", "my-branch"],
      "/tmp", stream, gh, runner,
    );

    expect(code).toBe(0);
    // The queue label and the park labels are all absent for the whole gate —
    // neither the candidate query nor the pre-claim recheck can select it.
    expect(labelsDuringGate).not.toContain("ready-for-agent");
    expect(labelsDuringGate).not.toContain("blocked:validation");
    expect(labelsDuringGate).not.toContain("ready-for-human");
  });

  it("also withholds ready-for-agent when adopting an issue that already carries it (#1307)", async () => {
    // A non-parked issue that is already claimable: adopting it must still strip
    // the queue label for the gate window, not leave it exposed.
    const { gh, state } = fakeGh({ state: "OPEN", body: "## Summary\nFoo.\n", labels: ["ready-for-agent"] });
    const { stream } = capture();
    let labelsDuringGate: string[] = [];
    const runner: RequeueAdoptRunner = async () => {
      labelsDuringGate = [...state.labels];
      return "landed";
    };

    const code = await requeueCommand(
      ["#42", "--guidance", "Adopt hand-done branch.", "--adopt-branch", "my-branch"],
      "/tmp", stream, gh, runner,
    );

    expect(code).toBe(0);
    expect(labelsDuringGate).not.toContain("ready-for-agent");
  });

  it("restores ready-for-agent when the adopt gate skips, so an empty/interrupted adopt is recoverable (#1307)", async () => {
    const { gh, state } = fakeGh({
      state: "OPEN",
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation"],
    });
    const { stream, text } = capture();
    let labelsDuringGate: string[] = [];
    const runner: RequeueAdoptRunner = async () => {
      labelsDuringGate = [...state.labels];
      return "skipped";
    };

    const code = await requeueCommand(
      ["#42", "--guidance", "Adopt.", "--adopt-branch", "empty-branch"],
      "/tmp", stream, gh, runner,
    );

    expect(code).toBe(0);
    // Withheld during the gate…
    expect(labelsDuringGate).not.toContain("ready-for-agent");
    // …restored after the gate skipped, so the Ticket is back in a queued state.
    expect(state.labels).toContain("ready-for-agent");
    expect(text()).toContain("skipped");
  });

  it("restores ready-for-agent when the adopt gate throws mid-run (#1307)", async () => {
    const { gh, state } = fakeGh({
      state: "OPEN",
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation"],
    });
    const { stream } = capture();
    const err = captureStderr();
    const runner: RequeueAdoptRunner = async () => {
      throw new Error("adopt interrupted");
    };

    await expect(
      requeueCommand(
        ["#42", "--guidance", "Adopt.", "--adopt-branch", "some-branch"],
        "/tmp", stream, gh, runner,
      ),
    ).rejects.toThrow("adopt interrupted");
    err.restore();

    // No stuck park labels, and the queue label is restored (recoverable state).
    expect(state.labels).toContain("ready-for-agent");
    expect(state.labels).not.toContain("blocked:validation");
    expect(state.labels).not.toContain("ready-for-human");
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
