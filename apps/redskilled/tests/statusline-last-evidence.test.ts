// While the daemon is down every surface says a generic "unreachable" — and
// the evidence for WHY sits on disk the whole time, in the death lane the
// daemon's own recorder writes. These tests pin the absence arm's second line:
// the newest daemon death, dated, with the record's own facts.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { appendProcessDeathRecord, buildProcessDeathRecord } from "@reddb-io/shared/death-record.js";
import {
  daemonDeathLanePath,
  readLastDaemonDeathHeadline,
} from "../src/statusline-last-evidence.js";
import { runStatusline } from "../src/statusline-command.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function laneWith(records: { ts: string; kind: "daemon" | "worker"; signal?: string | null; detail?: string }[]) {
  const home = await mkdtemp(join(tmpdir(), "redskilled-last-evidence-"));
  roots.push(home);
  const lane = daemonDeathLanePath(home);
  await mkdir(dirname(lane), { recursive: true });
  for (const record of records) {
    appendProcessDeathRecord(lane, buildProcessDeathRecord({
      kind: record.kind,
      id: `${record.kind}:99`,
      pid: 99,
      exit_path: record.signal == null ? "exit" : "signal",
      signal: record.signal ?? null,
      exit_code: record.signal == null ? 0 : null,
      last_phase: "serving",
      detail: record.detail ?? null,
      ts: record.ts,
    } as never, {} as never));
  }
  return { home, lane };
}

describe("the absence line names the last daemon death", () => {
  it("reads the newest daemon record with its age, path, and detail", async () => {
    const { lane } = await laneWith([
      { ts: "2026-08-24T10:00:00.000Z", kind: "daemon", signal: "SIGTERM" },
      { ts: "2026-08-24T18:00:00.000Z", kind: "worker", signal: "SIGKILL" },
      { ts: "2026-08-24T19:00:00.000Z", kind: "daemon", detail: "a newer published bundle is taking the session over" },
    ]);

    const headline = readLastDaemonDeathHeadline(lane, Date.parse("2026-08-24T20:30:00.000Z"));

    expect(headline).toContain("last daemon death 1h30m ago");
    expect(headline).toContain("exit 0");
    expect(headline).toContain("phase serving");
    expect(headline).toContain("a newer published bundle is taking the session over");
  });

  it("answers nothing for an absent lane or one holding only worker deaths", async () => {
    expect(readLastDaemonDeathHeadline("/nowhere/deaths.toonl", Date.now())).toBeNull();
    const { lane } = await laneWith([{ ts: "2026-08-24T10:00:00.000Z", kind: "worker", signal: "SIGKILL" }]);
    expect(readLastDaemonDeathHeadline(lane, Date.now())).toBeNull();
  });

  it("the unreachable statusline carries the evidence as its second line", async () => {
    const { home } = await laneWith([
      { ts: "2026-08-24T19:00:00.000Z", kind: "daemon", signal: "SIGTERM" },
    ]);
    const lines: string[] = [];

    await runStatusline([], {
      cwd: home,
      homeDir: home,
      now: () => "2026-08-24T19:45:00.000Z",
      write: (line) => void lines.push(line),
      warn: () => {},
      // A client that poses as a dead host: every read refuses.
      client: { request: async () => { throw new Error("connection refused"); } } as never,
      paths: { socketPath: join(home, "no.sock"), acpSocketPath: join(home, "no-acp.sock") } as never,
    });

    const output = lines.join("");
    expect(output).toContain("last daemon death 45m ago");
    expect(output).toContain("SIGTERM");
  });
});
