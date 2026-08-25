// Leak-audit finding #4 (2026-08-25): the outbox retained every GitHub write
// the daemon ever made (request and response body both) and the custodian
// retained every custody record ever handed off — for the process's life,
// with each mutation re-encoding the whole array. Published entries exist for
// idempotency REPLAY and terminal records are RECEIPTS: both wants are
// recent, so both stores now shed their oldest past a retention.
import { describe, expect, it } from "vitest";

import {
  compactGithubCustodySnapshot,
  GITHUB_CUSTODY_TERMINAL_RETENTION,
} from "../src/github-custody.js";
import {
  compactOutboxSnapshot,
  GITHUB_OUTBOX_PUBLISHED_RETENTION,
} from "../src/github-outbox.js";

describe("the outbox sheds old published entries and never a pending one", () => {
  it("keeps the newest published, all pending, and the original order", () => {
    const published = (index: number, state = "published", key = `k-${index}`) => ({
      idempotency_key: key,
      project_id: "github:1",
      project_label: "a/b",
      workspace_path: "/w",
      credential_profile: "personal",
      write: { kind: "issue-comment" },
      queued_at: "2026-08-25T00:00:00.000Z",
      state,
      value: { echoed: index },
    }) as never;
    const pending = published(-1, "pending", "obligation");
    const entries = [pending, ...Array.from({ length: GITHUB_OUTBOX_PUBLISHED_RETENTION + 40 }, (_u, index) => published(index))];

    const compacted = compactOutboxSnapshot({ version: 1, entries } as never);

    const kept = compacted.entries.map((entry) => (entry as { idempotency_key: string }).idempotency_key);
    expect(kept).toContain("obligation");
    expect(kept).not.toContain("k-0");
    expect(kept).not.toContain("k-39");
    expect(kept).toContain("k-40");
    expect(kept).toContain(`k-${GITHUB_OUTBOX_PUBLISHED_RETENTION + 39}`);
    expect(compacted.entries).toHaveLength(GITHUB_OUTBOX_PUBLISHED_RETENTION + 1);
  });

  it("a snapshot under the retention passes through untouched", () => {
    const value = { version: 1, entries: [] } as never;
    expect(compactOutboxSnapshot(value)).toBe(value);
  });
});

describe("the custodian sheds old terminal records and never an active one", () => {
  it("keeps every active record and the newest terminal receipts", () => {
    const record = (index: number, state: "active" | "terminal") => ({
      version: 1,
      project_id: "github:1",
      pull_request: index,
      branch: `red/w/${index}`,
      project_label: "a/b",
      workspace_path: "/w",
      credential_profile: "personal",
      handed_off_at: "2026-08-25T00:00:00.000Z",
      state,
      last_tick_at: null,
      last_forge_state: "unknown",
      next_action: "observe-forge",
      terminal_outcome: state === "terminal" ? "landed" : null,
    }) as never;
    const records = [
      record(1, "active"),
      ...Array.from({ length: GITHUB_CUSTODY_TERMINAL_RETENTION + 25 }, (_u, index) => record(100 + index, "terminal")),
      record(2, "active"),
    ];

    const compacted = compactGithubCustodySnapshot({ version: 1, records } as never);

    const prs = compacted.records.map((held) => (held as { pull_request: number; state: string }));
    expect(prs.filter((held) => held.state === "active")).toHaveLength(2);
    expect(prs.filter((held) => held.state === "terminal")).toHaveLength(GITHUB_CUSTODY_TERMINAL_RETENTION);
    expect(prs.some((held) => held.pull_request === 100)).toBe(false);
    expect(prs.some((held) => held.pull_request === 100 + GITHUB_CUSTODY_TERMINAL_RETENTION + 24)).toBe(true);
  });
});
