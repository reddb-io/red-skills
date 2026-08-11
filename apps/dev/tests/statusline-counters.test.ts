/**
 * The tail counters ride the daemon payload (ADR 0141 decision 2, #3566).
 *
 * The claim under test is what an OPERATOR sees: `prs=`, `iss=`, `rdy=` and
 * `hmn=` reach the statusline from the daemon document, each stating its own age
 * when it is served past the daemon's window — and no local `gh` count cache
 * stands anywhere between the fixture and the line.
 *
 * The daemon is a fixture payload drawn by the REAL shared renderer, not a
 * hand-typed string: a test that asserted against a string it wrote itself would
 * prove the assertion and not the render.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  renderRedskilledStatusline,
  REDSKILLED_RENDER_COUNTER_NAMES,
  REDSKILLED_STATUSLINE_DEFAULTS,
  stripAnsi,
  type RedskilledRenderCounter,
  type RedskilledRenderCounterName,
  type RedskilledRenderPayload,
} from "@reddb-io/redskilled-render";

const { localGit, runStatusline, probeStatusline } = vi.hoisted(() => ({
  localGit: vi.fn(async () => ({
    basename: "red-skills",
    branch: "afk/3566-counters",
    localAdded: 12,
    localRemoved: 3,
  })),
  runStatusline: vi.fn(async (
    _args: readonly string[],
    _io: { readonly write?: (line: string) => void },
  ) => 0),
  // The lifecycle wire (#3567) reaches the daemon through `probeStatusline`;
  // unstubbed it rejects, which is the honest daemon-absent default.
  probeStatusline: vi.fn(async (): Promise<unknown> => {
    throw new Error("no daemon in this test");
  }),
}));

vi.mock("@reddb-io/redskilled/statusline-command", () => ({ runStatusline, probeStatusline }));
vi.mock("../src/runtime/wire.js", () => ({
  collectStatuslineLocalGit: localGit,
  resolveRepoBasename: localGit,
}));

import { statuslineCommand } from "../src/commands/statusline.js";

const PROJECT = "acme/widgets";

function counters(
  values: Partial<Record<RedskilledRenderCounterName, number>>,
  ageMs: number,
  thresholdMs = 120_000,
): RedskilledRenderPayload["remote_counters"] {
  const built = {} as Record<RedskilledRenderCounterName, RedskilledRenderCounter>;
  for (const name of REDSKILLED_RENDER_COUNTER_NAMES) {
    const value = values[name];
    built[name] = value === undefined
      ? {
        name,
        value: null,
        fetched_at: null,
        age_ms: null,
        threshold_ms: thresholdMs,
        stale: false,
        reason: `this poll produced no ${name}, so it is absent rather than zero`,
      }
      : {
        name,
        value,
        fetched_at: "2026-08-11T00:00:00.000Z",
        age_ms: ageMs,
        threshold_ms: thresholdMs,
        stale: ageMs > thresholdMs,
        reason: `counted ${ageMs}ms ago`,
      };
  }
  return {
    version: 1,
    threshold_ms: thresholdMs,
    projects: [
      { project_label: PROJECT, repository: PROJECT, outcome: "counted", counters: built },
    ],
    reason: `every counter here was produced by one poll, ${ageMs}ms ago`,
  };
}

function daemonPayload(ageMs: number): RedskilledRenderPayload {
  return {
    version: 1,
    generated_at: "2026-08-11T00:05:00.000Z",
    daemon: {
      pid: 4242,
      daemon_version: "3.12.13",
      protocol_version: 1,
      started_at: "2026-08-10T00:00:00.000Z",
    },
    staleness: {
      sampled_at: "2026-08-11T00:05:00.000Z",
      age_ms: 1_000,
      threshold_ms: 30_000,
      stale: false,
      measured_worker_count: 0,
      unmeasured_workers: [],
      reason: "measured 1s ago",
    },
    host: {
      worker_count: 0,
      project_count: 1,
      ceiling: { memory_bytes: null, worker_count: 4 },
      consumption: { memory_bytes: 0 },
      observed_rss_bytes: 0,
      measured_worker_count: 0,
      ceiling_used_fraction: null,
    },
    projects: [
      { project_label: PROJECT, worker_count: 0, observed_rss_bytes: 0, measured_worker_count: 0 },
    ],
    workers: [],
    known_projects: [PROJECT],
    registered_projects: [PROJECT],
    remote_counters: counters(
      { open_pull_requests: 3, open_issues: 24, ready_queue: 5, human_queue: 2 },
      ageMs,
    ),
  };
}

/** The daemon, posed as the one thing it is here: a payload and the real render. */
function serve(ageMs: number): void {
  // The counters' own ages live inside the payload fixture (per-token ages,
  // ADR 0141); the PAYLOAD stays fresh, so the lifecycle resolves `live` and
  // the tail renders — counter age is data, never a lifecycle state.
  probeStatusline.mockImplementationOnce(async () => {
    const render = renderRedskilledStatusline(daemonPayload(ageMs), {
      ...REDSKILLED_STATUSLINE_DEFAULTS,
      project: PROJECT,
    });
    return {
      render: { lines: render.lines, mode: "project", project_match: "matched" },
      payload: {
        generated_at: new Date().toISOString(),
        staleness: { age_ms: 1_000, threshold_ms: 30_000, stale: false },
      },
    };
  });
}

const roots: string[] = [];
const cacheDir = process.env.RED_SKILLS_CACHE_DIR;

beforeEach(async () => {
  const empty = await mkdtemp(join(tmpdir(), "statusline-counters-cache-"));
  roots.push(empty);
  process.env.RED_SKILLS_CACHE_DIR = empty;
});

afterEach(async () => {
  vi.clearAllMocks();
  if (cacheDir === undefined) delete process.env.RED_SKILLS_CACHE_DIR;
  else process.env.RED_SKILLS_CACHE_DIR = cacheDir;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeStdin(text: string): NodeJS.ReadableStream & { isTTY?: boolean } {
  const stream = Readable.from([text]) as Readable & { isTTY?: boolean };
  stream.isTTY = false;
  return stream;
}

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  let output = "";
  return {
    stream: {
      write(chunk: string | Uint8Array): boolean {
        output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    text: () => output,
  };
}

async function render(ageMs: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "statusline-counters-"));
  roots.push(root);
  const out = sink();
  serve(ageMs);
  const code = await statuslineCommand([root], root, out.stream, fakeStdin("{}"));
  expect(code).toBe(0);
  return stripAnsi(out.text());
}

describe("statusline tail counters", () => {
  it("renders all four from the daemon payload, behind the bedrock", async () => {
    const line = await render(5_000);

    expect(line).toContain("prs=3 iss=24 rdy=5 hmn=2");
    // The bedrock still LEADS: the counters are the tail's, and the tail follows.
    expect(line.indexOf("red-skills (afk/3566-counters)")).toBeLessThan(line.indexOf("prs=3"));
    expect(line).toContain("loc=+12 -3");
  });

  it("states each counter's age when the daemon served it past its window", async () => {
    expect(await render(900_000)).toContain("prs=3(15m) iss=24(15m) rdy=5(15m) hmn=2(15m)");
  });
});
