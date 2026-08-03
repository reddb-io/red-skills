// One render implementation, outside the daemon (ADR 0132 decisions 1, 2 and 9).
//
// The four claims this file pins are the issue's acceptance criteria: the layout
// lives in exactly one module, that module holds no state and opens no transport,
// the daemon serves the skeleton unconditionally and the count-scaling extras on
// request, and no layout logic is left behind in `apps/redskilled`.
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encode as encodeToon } from "@reddb-io/toon";
import {
  decodeRedskilledPayload,
  renderRedskilled,
  renderRedskilledStatusline,
  REDSKILLED_STATUSLINE_DEFAULTS,
  type RedskilledRenderPayload,
} from "@reddb-io/redskilled-render";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { readRedskilledStatuslinePayload } from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import {
  REDSKILLED_STATUSLINE_EXTRAS,
  withholdStatuslineExtras,
  type RedskilledStatuslinePayload,
} from "../src/statusline-payload.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-render-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

function worker(overrides: Partial<RedskilledWorkerView> = {}): RedskilledWorkerView {
  return {
    worker_id: "w-1",
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-08-03T00:00:00.000Z",
    workspace_path: "/tmp/acme/w-1",
    isolated: true,
    unit: "red-worker-acme-widgets-w-1.service",
    budget: { memory_max: "1G" },
    warnings: [],
    ...overrides,
  };
}

async function liveDaemon(): Promise<{ daemon: RedskilledDaemon; paths: RedskilledPaths }> {
  const paths = await sessionPaths();
  const daemon = await startRedskilledDaemon({
    paths,
    idleMs: 60_000,
    sampleMs: 0,
    ceiling: UNBOUNDED_HOST_CEILING,
    stopWorker: () => true,
    treeSampler: () => ({ rss: { "w-1": 512 * 1024 * 1024 }, cpu_seconds: {} }),
  });
  running.push(daemon);
  daemon.trackWorker(worker());
  await daemon.sampleMemoryBudgets();
  return { daemon, paths };
}

describe("one render module, and the daemon's payload satisfies it", () => {
  it("hands the daemon's own payload to the shared render with no adaptation", async () => {
    const { daemon } = await liveDaemon();
    const live: RedskilledStatuslinePayload = daemon.statuslinePayload();
    // The assignment IS the ratchet: the daemon composes a superset of the wire
    // document the render declares, and a field that changed shape here fails to
    // compile rather than failing to draw.
    const asRendered: RedskilledRenderPayload = live;
    const drawn = renderRedskilledStatusline(asRendered, {
      ...REDSKILLED_STATUSLINE_DEFAULTS,
      project: "acme/widgets",
    });
    expect(drawn.line).toContain("acme/widgets 1w");
    // Known by NAME: this daemon holds the Worker and no registration for its
    // project, and the shared render says so from the payload alone (#2973).
    expect(drawn.project_match).toBe("name-only");
  });

  it("draws a live payload exactly as it draws the same bytes off a file", async () => {
    const { daemon } = await liveDaemon();
    const live = daemon.statuslinePayload();
    const taste = { density: "line", options: { project: "acme/widgets" } } as const;

    const fromLive = renderRedskilled(live, taste);
    const fromJson = renderRedskilled(JSON.stringify(live), taste);
    const fromToon = renderRedskilled(encodeToon(live as never), taste);

    expect(fromJson.lines).toEqual(fromLive.lines);
    expect(fromToon.lines).toEqual(fromLive.lines);
    expect(decodeRedskilledPayload(encodeToon(live as never)).encoding).toBe("toon");
  });
});

describe("the skeleton is unconditional and the extras are asked for", () => {
  it("serves Workers, projects and the budget on every response", async () => {
    const { paths } = await liveDaemon();
    const skeleton = await readRedskilledStatuslinePayload(paths, {}, {});

    expect(skeleton.workers).toHaveLength(1);
    expect(skeleton.projects).toHaveLength(1);
    expect(skeleton.github_balance).toBeDefined();
    expect(skeleton.host.observed_rss_bytes).toBeGreaterThan(0);
    // Every count-scaling block was withheld, and the payload SAYS so: without
    // this a consumer would read a cheap read as a stopped sampler.
    expect([...(skeleton.withheld ?? [])].sort()).toEqual([...REDSKILLED_STATUSLINE_EXTRAS].sort());
    expect(skeleton.workers[0]!.vitals.rss_bytes).toBeNull();
  });

  it("serves the extras that were named, and nothing more", async () => {
    const { paths } = await liveDaemon();
    const withVitals = await readRedskilledStatuslinePayload(paths, {}, { vitals: true });

    expect(withVitals.withheld).toEqual(["logs", "display"]);
    expect(withVitals.workers[0]!.vitals.rss_bytes).toBe(512 * 1024 * 1024);
    expect(withVitals.workers[0]!.log.last_line).toBeNull();
  });

  it("answers a client that names no extras with the whole document", async () => {
    const { paths } = await liveDaemon();
    // The compatibility spelling: every bundle pinned before ADR 0132 decision 2
    // sends no `extras`, and a daemon that read that as "the skeleton" would
    // silently impoverish every surface on the machine (ADR 0130 rule 3).
    const whole = await readRedskilledStatuslinePayload(paths, {});
    expect(whole.withheld).toBeUndefined();
    expect(whole.workers[0]!.vitals.rss_bytes).toBe(512 * 1024 * 1024);
  });

  it("withholds purely — the shape stays total, so a consumer needs no guard", async () => {
    const { daemon } = await liveDaemon();
    const whole = daemon.statuslinePayload();
    const thin = withholdStatuslineExtras(whole, {});

    expect(thin.workers[0]!.vitals).toEqual({
      rss_bytes: null,
      sampled_at: null,
      age_ms: null,
      fresh: false,
      rss_source: null,
    });
    expect(thin.workers[0]!.log).toEqual({ last_line: null, published_at: null, source: null });
    expect(thin.workers[0]!.display).toBeNull();
    // The aggregates are skeleton and survive: the head answers "how much of this
    // machine is in use" whatever a reader declined to fetch.
    expect(thin.host).toEqual(whole.host);
    expect(thin.projects).toEqual(whole.projects);
  });
});

describe("no layout logic remains in apps/redskilled", () => {
  it("holds no render module of its own", () => {
    const src = readdirSync(join(import.meta.dirname, "..", "src"));
    expect(src).not.toContain("statusline-render.ts");
    expect(src).not.toContain("dashboard-render.ts");
  });

  it("spells no line, row or column anywhere but the render package", () => {
    const src = join(import.meta.dirname, "..", "src");
    // The marks are the smallest piece of layout there is, so they are the
    // cheapest thing to fork and the surest signal that a second layout started.
    for (const name of readdirSync(src).filter((file) => file.endsWith(".ts"))) {
      const body = readFileSync(join(src, name), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(body, name).not.toMatch(/["'`][^"'`]*†[^"'`]*["'`]/);
      expect(body, name).not.toMatch(/["'`][^"'`]*↳[^"'`]*["'`]/);
      expect(body, name).not.toMatch(/!unregistered|!lapsed|slots=|wrk=|tk\/m=/);
    }
  });
});
