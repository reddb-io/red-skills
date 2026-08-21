import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGithubCustodian,
  type RedskilledGithubCustodyForgeView,
  type RedskilledGithubCustodyUpstream,
} from "../src/github-custody.js";

// #4130: land carries the validated commit, and the merge driver remembers the
// head SHA it armed. A driver pass whose observed head differs REPORTS the
// mismatch instead of arming a commit nobody validated.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PROJECT = {
  projectId: "github:9001",
  projectLabel: "acme/widgets",
  workspacePath: "/tmp/acme-widgets",
  credentialProfile: "default",
};
const CREDENTIAL = { secret: "s" };
const ARMED = "1".repeat(40);
const MOVED = "2".repeat(40);

function upstreamFixture(headSha: () => string) {
  let armCalls = 0;
  const view = (native: boolean): RedskilledGithubCustodyForgeView => ({
    forge_state: "open-clean",
    native_intent: native,
    head_sha: headSha(),
  });
  const upstream: RedskilledGithubCustodyUpstream = {
    async observe() { return view(false); },
    async arm() { armCalls += 1; return view(true); },
  };
  return { upstream, armCalls: () => armCalls };
}

async function custodyPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-armed-head-"));
  roots.push(root);
  return join(root, "github-custody.toon");
}

async function tickOnce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("the armed head on merge custody (#4130)", () => {
  it("arms when the observed head IS the validated commit, and round-trips it through the snapshot", async () => {
    const path = await custodyPath();
    const { upstream, armCalls } = upstreamFixture(() => ARMED);
    const custodian = createGithubCustodian({
      path, upstream, clock: () => new Date().toISOString(), tickMs: 5, inertMs: 60_000,
    });
    const record = await custodian.handoff(PROJECT, CREDENTIAL, {
      pull_request: 73, owner_ticket: 4130, branch: "afk/4130", base: "main", armed_head: ARMED,
    });
    expect(record.armed_head).toBe(ARMED);
    await tickOnce();
    expect(armCalls()).toBeGreaterThan(0);
    custodian.close();

    // The snapshot remembers the armed head across a daemon replacement.
    const revived = createGithubCustodian({
      path, upstream, clock: () => new Date().toISOString(), tickMs: 3_600_000, inertMs: 3_600_000,
    });
    const status = await revived.status(PROJECT, CREDENTIAL);
    expect(status.records[0]?.armed_head).toBe(ARMED);
    revived.close();
  });

  it("reports a moved head instead of arming a commit nobody validated", async () => {
    const path = await custodyPath();
    const { upstream, armCalls } = upstreamFixture(() => MOVED);
    const custodian = createGithubCustodian({
      path, upstream, clock: () => new Date().toISOString(), tickMs: 5, inertMs: 60_000,
    });
    await custodian.handoff(PROJECT, CREDENTIAL, {
      pull_request: 74, owner_ticket: 4130, branch: "afk/4130-moved", base: "main", armed_head: ARMED,
    });
    await tickOnce();
    expect(armCalls()).toBe(0);
    const status = await custodian.status(PROJECT, CREDENTIAL);
    expect(status.records[0]?.next_action).toBe("report-moved-head");
    expect(status.records[0]?.state).toBe("active");
    custodian.close();
  });

  it("a re-landing restates the validated head on the same pull request", async () => {
    const path = await custodyPath();
    const { upstream } = upstreamFixture(() => ARMED);
    const custodian = createGithubCustodian({
      path, upstream, clock: () => new Date().toISOString(), tickMs: 3_600_000, inertMs: 3_600_000,
    });
    const handoff = {
      pull_request: 75, owner_ticket: 4130, branch: "afk/4130-restate", base: "main",
    };
    await custodian.handoff(PROJECT, CREDENTIAL, { ...handoff, armed_head: ARMED });
    const restated = await custodian.handoff(PROJECT, CREDENTIAL, { ...handoff, armed_head: MOVED });
    expect(restated.armed_head).toBe(MOVED);
    custodian.close();
  });

  it("a record written before the armed head existed still parses and never reports a mismatch", async () => {
    const path = await custodyPath();
    const { upstream, armCalls } = upstreamFixture(() => MOVED);
    const custodian = createGithubCustodian({
      path, upstream, clock: () => new Date().toISOString(), tickMs: 5, inertMs: 60_000,
    });
    await custodian.handoff(PROJECT, CREDENTIAL, {
      pull_request: 76, owner_ticket: 4130, branch: "afk/4130-legacy", base: "main",
    });
    await tickOnce();
    expect(armCalls()).toBeGreaterThan(0);
    custodian.close();
  });
});

/**
 * Entry point `acp-land-method` (Ticket #4138, ADR 0154). `bindAcpWorkerLand`
 * is the daemon's door, and its verdict source is the `commit` the request
 * carries: validated as one full object name and pinned as the custody
 * record's `armed_head`, so a head that moves after arming is REPORTED rather
 * than merged. The ledger question is deliberately not asked here — a daemon
 * that read a project's verdicts would hold the per-issue policy ADR 0144 keeps
 * out of it, so the Worker asks it before the request is ever sent.
 */
describe("the ACP land method's verdict source is the head it was handed (#4138)", () => {
  it("refuses a handoff whose armed head is not one full object name", async () => {
    const path = await custodyPath();
    const { upstream } = upstreamFixture(() => ARMED);
    const custodian = createGithubCustodian({
      path, upstream, clock: () => new Date().toISOString(), tickMs: 3_600_000, inertMs: 3_600_000,
    });

    await expect(
      custodian.handoff(PROJECT, CREDENTIAL, {
        pull_request: 76, owner_ticket: 4138, branch: "afk/4138", base: "main", armed_head: "abc",
      }),
    ).rejects.toThrow(/full commit object name/);
    custodian.close();
  });

  it("a head that moved after arming never merges — it is reported and watched", async () => {
    const path = await custodyPath();
    const { upstream, armCalls } = upstreamFixture(() => MOVED);
    const custodian = createGithubCustodian({
      path, upstream, clock: () => new Date().toISOString(), tickMs: 5, inertMs: 60_000,
    });
    await custodian.handoff(PROJECT, CREDENTIAL, {
      pull_request: 77, owner_ticket: 4138, branch: "afk/4138-moved", base: "main", armed_head: ARMED,
    });
    await tickOnce();

    expect(armCalls()).toBe(0);
    const status = await custodian.status(PROJECT, CREDENTIAL);
    expect(status.records[0]?.next_action).toBe("report-moved-head");
    custodian.close();
  });
});
