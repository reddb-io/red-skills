// A durable custody record whose driver died is a promise nobody keeps: the
// custodian's timers are in-memory and only a client's handoff/status call
// re-armed them, so every daemon restart parked active records on
// `repair-custodian` until someone happened to ask (nine PRs once waited
// thirteen hours on a two-minute threshold). The tender executes the record's
// own published repair at boot, from the snapshot the custodian persists.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encode, type JsonValue } from "@reddb-io/toon";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startGithubCustodyTender, tendGithubCustody } from "../src/github-custody-tender.js";
import type { RedskilledGithubGatewayRegistration } from "../src/github-project-credential.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function custodyRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    pull_request: 4319,
    owner_ticket: 4280,
    branch: "red/x/4280",
    base: "main",
    project_id: "github:1",
    project_label: "reddb-io/red-skills",
    workspace_path: "/tmp/workspace",
    credential_profile: "personal",
    handed_off_at: "2026-08-24T06:00:00.000Z",
    state: "active",
    last_tick_at: null,
    last_forge_state: "unknown",
    next_action: "repair-custodian",
    terminal_outcome: null,
    ...overrides,
  };
}

async function snapshotAt(records: Record<string, unknown>[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-custody-tender-"));
  roots.push(root);
  const path = join(root, "state", "github", "custody.toon");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${encode({ version: 1, records } as unknown as JsonValue)}\n`);
  return path;
}

function registration(statuses: { project: string; profile: string }[]) {
  const mergeCustodyStatus = vi.fn(async () => ({ version: 1, records: [] }));
  const reg: RedskilledGithubGatewayRegistration = {
    gateway: {
      forProject: (authority: { projectId: string; credentialProfile: string }) => {
        statuses.push({ project: authority.projectId, profile: authority.credentialProfile });
        return { mergeCustodyStatus } as never;
      },
    } as never,
    credentialForProfile: async (profile) =>
      profile === "personal" ? { secret: "personal-token" } : null,
    credentialForProject: async () => null,
  };
  return { reg, mergeCustodyStatus };
}

describe("the merge-custody tender", () => {
  it("tendGithubCustody resumes each active project execution and reports the credential-less ones", async () => {
    const path = await snapshotAt([
      custodyRecord({}),
      custodyRecord({ pull_request: 4321 }),
      custodyRecord({ pull_request: 4322, state: "terminal", next_action: "none" }),
      custodyRecord({
        pull_request: 9,
        project_id: "github:2",
        project_label: "reddb-io/other",
        credential_profile: "an-app-nobody-configured",
      }),
    ]);
    const statuses: { project: string; profile: string }[] = [];
    const { reg, mergeCustodyStatus } = registration(statuses);

    const report = await tendGithubCustody({ custodyPath: path, registration: reg });

    // One status call per distinct project/credential pair re-arms every
    // record that project holds — two active records, one resume.
    expect(report).toEqual({ resumed: 1, unresolved: ["github:2"] });
    expect(statuses).toEqual([{ project: "github:1", profile: "personal" }]);
    expect(mergeCustodyStatus).toHaveBeenCalledTimes(1);
  });

  it("an absent or unreadable snapshot is an empty pass, never a throw", async () => {
    const { reg } = registration([]);
    await expect(tendGithubCustody({ custodyPath: "/nowhere/custody.toon", registration: reg }))
      .resolves.toEqual({ resumed: 0, unresolved: [] });
  });

  it("startGithubCustodyTender runs one pass immediately and hands the report to its sink", async () => {
    const path = await snapshotAt([custodyRecord({})]);
    const { reg } = registration([]);
    const reports: unknown[] = [];
    const tender = startGithubCustodyTender({
      custodyPath: path,
      registration: reg,
      intervalMs: 60_000,
      onReport: (report) => reports.push(report),
    });
    try {
      await vi.waitFor(() => {
        expect(reports).toEqual([{ resumed: 1, unresolved: [] }]);
      });
    } finally {
      tender.stop();
    }
  });
});
