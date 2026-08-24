// The durable session journal rewrites its WHOLE snapshot on every append, and
// every MCP surface and self-healing re-dial opens a session — so about half
// of a live host's rows were connect-and-never-prompt records and cumulative
// write cost grew quadratically (1612 rows, ~1 MB per write). Retention runs
// where the writer runs: empty rows past their TTL are shed at load and on
// every create, and the map is capped at the newest records.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ACP_SESSION_EMPTY_TTL_MS,
  ACP_SESSION_JOURNAL_CAP,
  compactAcpSessions,
  createAcpSessionJournal,
  type AcpSessionJournalRecord,
} from "../src/acp-session-journal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const project = {
  projectId: "github:1",
  projectLabel: "reddb-io/red-skills",
  workspacePath: "/tmp/workspace",
} as never;

function row(overrides: Partial<AcpSessionJournalRecord>): AcpSessionJournalRecord {
  return {
    public_session_id: "session",
    project_id: "github:1",
    project_label: "reddb-io/red-skills",
    workspace_path: "/tmp/workspace",
    entries: [],
    session_evidence: [],
    ...overrides,
  } as AcpSessionJournalRecord;
}

describe("compactAcpSessions", () => {
  const now = Date.parse("2026-08-24T20:00:00.000Z");

  it("drops connect-only sessions past the retention window and keeps fresh ones", () => {
    const kept = compactAcpSessions([
      row({ public_session_id: "stale-empty", updated_at: "2026-08-22T00:00:00.000Z" }),
      row({ public_session_id: "fresh-empty", updated_at: "2026-08-24T19:30:00.000Z" }),
      row({ public_session_id: "legacy-empty" }),
    ], now);

    expect(kept.map((record) => record.public_session_id)).toEqual(["fresh-empty"]);
  });

  it("keeps sessions with entries or evidence regardless of age", () => {
    const kept = compactAcpSessions([
      row({
        public_session_id: "old-but-worked",
        updated_at: "2026-01-01T00:00:00.000Z",
        entries: [{ kind: "prompt", sequence: 1 } as never],
      }),
      row({
        public_session_id: "old-with-evidence",
        session_evidence: [{ worker_id: "w" } as never],
      }),
    ], now);

    expect(kept.map((record) => record.public_session_id).sort()).toEqual([
      "old-but-worked",
      "old-with-evidence",
    ]);
  });

  it("caps the journal at the newest records", () => {
    const crowd = Array.from({ length: ACP_SESSION_JOURNAL_CAP + 25 }, (_, index) =>
      row({
        public_session_id: `session-${String(index).padStart(4, "0")}`,
        entries: [{ kind: "prompt", sequence: 1 } as never],
        updated_at: new Date(now - index * 1000).toISOString(),
      }));

    const kept = compactAcpSessions(crowd, now);

    expect(kept).toHaveLength(ACP_SESSION_JOURNAL_CAP);
    // The newest survive; the 25 oldest are shed.
    expect(kept.some((record) => record.public_session_id === "session-0000")).toBe(true);
    expect(kept.some((record) => record.public_session_id === `session-${ACP_SESSION_JOURNAL_CAP + 24}`)).toBe(false);
  });
});

describe("the journal applies its own retention", () => {
  it("stamps created_at on new sessions and sheds expired empties on load", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-journal-retention-"));
    roots.push(root);
    const path = join(root, "redskilled.acp-sessions.toon");
    let now = "2026-08-24T20:00:00.000Z";
    const clock = () => now;

    const journal = await createAcpSessionJournal(path, clock);
    await journal.create("connect-only", project);
    await journal.create("worked", project);
    await journal.prompt("worked", [{ type: "text", text: "do things" }] as never);

    // A day later, a fresh daemon loads the journal: the connect-only row is
    // past its window and gone; the worked session survives with its history.
    now = new Date(Date.parse(now) + ACP_SESSION_EMPTY_TTL_MS + 60_000).toISOString();
    const reborn = await createAcpSessionJournal(path, clock);
    expect(() => reborn.recovery("connect-only")).toThrow(/unknown durable/);
    expect(reborn.recovery("worked").entries).toHaveLength(1);
  });
});
