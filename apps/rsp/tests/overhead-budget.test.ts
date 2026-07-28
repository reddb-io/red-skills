import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode, type JsonValue } from "@reddb-io/toon";
import { readGhEtagCache } from "../src/gh-conditional.js";
import { emitWrappedResult } from "../src/cli/invocation-telemetry.js";
import { passthroughSelfDisabled } from "../src/cli/passthrough.js";
import { renderRspStatus } from "../src/cli/stats.js";
import {
  DEFAULT_RSP_OVERHEAD_CEILING,
  RSP_OVERHEAD_FAMILIES,
  classifyOverheadSample,
  noteChildProcessMs,
  noteSelfStateBytesRead,
  overheadCounters,
  overheadFamilyDisabled,
  overheadHealth,
  overheadLedgerPath,
  overheadTelemetryFields,
  readOverheadLedger,
  recordOverheadSample,
  resetOverheadCounters,
  resetOverheadLedger,
  type RspOverheadCeiling,
  type RspOverheadSample,
} from "../src/overhead-budget.js";
import { telemetrySpoolPath } from "../src/telemetry.js";

const roots: string[] = [];

const TEST_CEILING: RspOverheadCeiling = {
  maxOverheadMs: 50,
  maxSelfStateBytes: 4096,
  netLossFloorBytes: 1024,
  consecutiveBreaches: 3,
  cooldownMs: 60_000,
};

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-overhead-"));
  roots.push(root);
  await mkdir(join(root, ".red", "state", "rsp"), { recursive: true });
  return root;
}

function sample(overrides: Partial<RspOverheadSample> = {}): RspOverheadSample {
  return {
    family: "git",
    wrapperMs: 10,
    childMs: 8,
    selfStateBytesRead: 128,
    bytesSaved: 4096,
    ...overrides,
  };
}

beforeEach(() => {
  resetOverheadCounters();
});

afterEach(async () => {
  resetOverheadCounters();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rsp overhead budget (#2746)", () => {
  it("records added wall clock and self-state bytes for every wrapper family, not just savings", async () => {
    const root = await tempRoot();

    for (const family of RSP_OVERHEAD_FAMILIES) {
      const state = recordOverheadSample(
        root,
        sample({ family, wrapperMs: 940, childMs: 900, selfStateBytesRead: 512 }),
        TEST_CEILING,
      );
      expect(state.family).toBe(family);
      expect(state.last_overhead_ms).toBe(40);
      expect(state.last_self_state_bytes_read).toBe(512);
      expect(state.last_bytes_saved).toBe(4096);
      expect(state.invocations).toBe(1);
    }

    const ledger = readOverheadLedger(root);
    expect(Object.keys(ledger.families).sort()).toEqual([...RSP_OVERHEAD_FAMILIES].sort());

    const fields = overheadTelemetryFields(sample({ wrapperMs: 940, childMs: 900 }), TEST_CEILING);
    expect(fields).toMatchObject({
      wrapper_ms: 940,
      overhead_ms: 40,
      child_ms: 900,
      self_state_bytes_read: 128,
      bytes_saved: 4096,
      overhead_breached: false,
    });
  });

  it("never charges rsp for the wrapped command's own runtime", () => {
    const verdict = classifyOverheadSample(
      sample({ wrapperMs: 120_000, childMs: 119_990, selfStateBytesRead: 64 }),
      TEST_CEILING,
    );

    expect(verdict.overhead_ms).toBe(10);
    expect(verdict.breached).toBe(false);
  });

  it("writes both sides of the ledger through the invocation seam every wrapper passes through", async () => {
    const root = await tempRoot();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    noteSelfStateBytesRead(2048);
    noteChildProcessMs(1);

    const status = await emitWrappedResult(
      { command: "git", level: "brief", positional: ["git", "status"] },
      {
        stdout: Buffer.from("short summary"),
        stderr: Buffer.alloc(0),
        status: 0,
        signal: null,
        rawOutput: Buffer.from("x".repeat(9000)),
      },
      process.hrtime.bigint(),
      undefined,
      root,
      undefined,
      TEST_CEILING,
    );

    expect(status).toBe(0);
    const spool = await readFile(telemetrySpoolPath(root), "utf8");
    expect(spool).toContain("overhead_ms");
    expect(spool).toContain("self_state_bytes_read");
    const recorded = readOverheadLedger(root).families.git;
    expect(recorded?.last_self_state_bytes_read).toBe(2048);
    expect(recorded?.last_bytes_saved).toBe(9000 - "short summary".length);
  });

  it("disables a wrapper after N consecutive ceiling breaches and reports why", async () => {
    const root = await tempRoot();
    const breaching = sample({ family: "gh", selfStateBytesRead: 10 * 1024 * 1024, bytesSaved: 200 });

    const first = recordOverheadSample(root, breaching, TEST_CEILING);
    const second = recordOverheadSample(root, breaching, TEST_CEILING);
    expect(first.disabled).toBe(false);
    expect(second.consecutive_breaches).toBe(2);
    expect(overheadFamilyDisabled(root, "gh")).toBeNull();

    const third = recordOverheadSample(root, breaching, TEST_CEILING);
    expect(third.disabled).toBe(true);
    expect(third.reasons).toContain("self-state-byte-ceiling");
    expect(third.disabled_reason).toContain("gh");
    expect(third.disabled_reason).toContain("3 consecutive invocations");
    expect(overheadFamilyDisabled(root, "gh")?.disabled_reason).toBe(third.disabled_reason);
  });

  it("re-arms a self-disabled family once its cooldown lapses, and clears it on an in-budget invocation", async () => {
    const root = await tempRoot();
    const breaching = sample({ family: "cat", selfStateBytesRead: 8 * 1024, bytesSaved: 0 });
    const start = Date.parse("2026-07-28T00:00:00.000Z");

    for (let i = 0; i < 3; i += 1) recordOverheadSample(root, breaching, TEST_CEILING, start);
    expect(overheadFamilyDisabled(root, "cat", start + 1_000)?.disabled).toBe(true);
    expect(overheadFamilyDisabled(root, "cat", start + TEST_CEILING.cooldownMs + 1)).toBeNull();

    const healthy = recordOverheadSample(root, sample({ family: "cat" }), TEST_CEILING, start + TEST_CEILING.cooldownMs + 2);
    expect(healthy.disabled).toBe(false);
    expect(healthy.consecutive_breaches).toBe(0);
    expect(overheadHealth(root, TEST_CEILING, start + TEST_CEILING.cooldownMs + 3).verdict).toBe("green");
  });

  it("renders a red status verdict while a ceiling is breached and green on a healthy run", async () => {
    const root = await tempRoot();
    const resident = { state: "registered-alive-socket-healthy" };

    const green = renderRspStatus(resident, overheadHealth(root, TEST_CEILING));
    expect(green).toContain("verdict: green");
    expect(green).toContain("every wrapper family is inside its overhead ceiling");

    recordOverheadSample(root, sample({ family: "proxy", wrapperMs: 900, childMs: 10 }), TEST_CEILING);
    const red = renderRspStatus(resident, overheadHealth(root, TEST_CEILING));
    expect(red).toContain("verdict: red");
    expect(red).toContain("proxy");
    expect(red).toContain("wall-clock-ceiling");
    expect(red).toContain("registered-alive-socket-healthy");
  });

  it("keeps fail-open semantics exactly when a family is self-disabled: raw stdout, stderr and exit status", async () => {
    const root = await tempRoot();
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });

    const status = await passthroughSelfDisabled(
      ["bash", "-c", "printf 'raw-stdout'; printf 'raw-stderr' 1>&2; exit 7"],
      root,
      { family: "gh", disabled_reason: "self-state read > ceiling", reasons: ["self-state-byte-ceiling"] },
    );

    expect(status).toBe(7);
    expect(out.join("")).toBe("raw-stdout");
    expect(err.join("")).toBe("raw-stderr");
  });

  it("routes a self-disabled family through the raw command from the cli entrypoint", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
    // Big enough that the wrapper would summarize it: raw bytes prove the
    // self-disabled family really ran the command untouched.
    const payload = `${Array.from({ length: 2000 }, (_, i) => `line ${i} alpha beta gamma`).join("\n")}\n`;
    await writeFile(join(root, "notes.txt"), payload, "utf8");
    for (let i = 0; i < 3; i += 1) {
      recordOverheadSample(root, sample({ family: "cat", selfStateBytesRead: 8 * 1024, bytesSaved: 0 }), TEST_CEILING);
    }
    expect(overheadFamilyDisabled(root, "cat")?.disabled).toBe(true);

    const out: string[] = [];
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const { main } = await import("../src/cli/main.js");
    const status = await main(["cat", join(root, "notes.txt")]);

    expect(status).toBe(0);
    expect(out.join("")).toBe(payload);
  });

  it("trips the ceiling on an oversized self-state file instead of absorbing it silently (#2745 shape)", async () => {
    const root = await tempRoot();
    const body = "y".repeat(2 * 1024 * 1024);
    await writeFile(
      join(root, ".red", "state", "rsp", "gh-etag-cache.toon"),
      `${encode({
        version: 1,
        entries: {
          fat: { key: "fat", request: "{}", etag: "e", body, updated_at: "2026-07-28T00:00:00.000Z" },
        },
      } as unknown as JsonValue)}\n`,
      "utf8",
    );

    const cache = await readGhEtagCache(root);
    expect(Object.keys(cache.entries)).toEqual(["fat"]);
    const counters = overheadCounters();
    expect(counters.selfStateBytesRead).toBeGreaterThan(2 * 1024 * 1024);

    const verdict = classifyOverheadSample(
      { family: "gh-api-json", wrapperMs: 40, childMs: 30, selfStateBytesRead: counters.selfStateBytesRead, bytesSaved: 1200 },
      DEFAULT_RSP_OVERHEAD_CEILING,
    );
    expect(verdict.breached).toBe(true);
    expect(verdict.reasons).toEqual(["self-state-byte-ceiling", "overhead-exceeds-savings"]);

    const state = recordOverheadSample(
      root,
      { family: "gh-api-json", wrapperMs: 40, childMs: 30, selfStateBytesRead: counters.selfStateBytesRead, bytesSaved: 1200 },
      { ...DEFAULT_RSP_OVERHEAD_CEILING, consecutiveBreaches: 1 },
    );
    expect(state.disabled).toBe(true);
    expect(state.disabled_reason).toContain("self-state read");
    expect(overheadHealth(root, DEFAULT_RSP_OVERHEAD_CEILING).verdict).toBe("red");
  });

  it("round-trips the ledger through its TOON state file and resets on demand", async () => {
    const root = await tempRoot();
    recordOverheadSample(root, sample({ family: "vitest" }), TEST_CEILING);

    const raw = await readFile(overheadLedgerPath(root), "utf8");
    expect(raw).toContain("vitest");
    expect(readOverheadLedger(root).families.vitest?.invocations).toBe(1);

    resetOverheadLedger(root);
    expect(readOverheadLedger(root).families).toEqual({});
  });
});
