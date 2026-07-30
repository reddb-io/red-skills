// The rendered statusline lives on the tool surface, so no agent host renders
// it. The string is a pure function of the payload — proven here rather than
// left to discipline — the default mode is the local project's Workers, `global`
// names the owner of each, a crowded machine degrades to an aggregate instead of
// overflowing, and every default is declarable in config with a flag above it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { runStatusline } from "../src/cli.js";
import { readRedskilledStatuslinePayload, readRedskilledStatuslineString } from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { buildHostState, type RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { isRedskilledStatuslineRender } from "../src/protocol.js";
import {
  parseRedskilledStatuslineFlags,
  readRedskilledStatuslineConfig,
  resolveRedskilledStatuslineOptions,
} from "../src/statusline-config.js";
import {
  REDSKILLED_STATUSLINE_DEFAULTS,
  renderRedskilledStatusline,
  type RedskilledStatuslineOptions,
} from "../src/statusline-render.js";
import type { RedskilledStatuslinePayload } from "../src/statusline-payload.js";
import { buildStatuslinePayload } from "../src/statusline-payload.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await scratch("redskilled-statusline-string-");
  return resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
}

function worker(overrides: Partial<RedskilledWorkerView> = {}): RedskilledWorkerView {
  return {
    worker_id: "w-1",
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-07-29T00:00:00.000Z",
    workspace_path: "/tmp/acme/w-1",
    isolated: true,
    unit: "red-worker-acme-widgets-w-1.service",
    budget: { memory_max: "1G" },
    warnings: [],
    ...overrides,
  };
}

const MB = 1024 * 1024;

/** A payload built the way the daemon builds it, from a fixed instant. */
function payloadOf(
  workers: readonly RedskilledWorkerView[],
  rss: Record<string, number> = {},
  overrides: { sampledAt?: string | null; now?: string } = {},
): RedskilledStatuslinePayload {
  return buildStatuslinePayload({
    hostState: buildHostState({
      daemonVersion: "0.1.0",
      machineIdHash: "mach",
      sessionKeyHash: "sess",
      pid: 99,
      startedAt: "2026-07-29T00:00:00.000Z",
      workers,
    }),
    ceiling: UNBOUNDED_HOST_CEILING,
    rss,
    sampledAt: overrides.sampledAt === undefined ? "2026-07-29T01:00:00.000Z" : overrides.sampledAt,
    now: overrides.now ?? "2026-07-29T01:00:05.000Z",
  });
}

function options(overrides: Partial<RedskilledStatuslineOptions> = {}): RedskilledStatuslineOptions {
  return { ...REDSKILLED_STATUSLINE_DEFAULTS, ...overrides };
}

/** Many projects, each with one Worker, so the global view has to give up detail. */
function crowdedWorkers(projects: number): RedskilledWorkerView[] {
  return Array.from({ length: projects }, (_, index) =>
    worker({
      worker_id: `w-${index}`,
      project_label: `acme/project-with-a-long-name-${index}`,
      pid: 5000 + index,
      workspace_path: `/tmp/acme/w-${index}`,
      unit: `red-worker-${index}.service`,
    }));
}

describe("the rendered statusline", () => {
  it("is a pure function of the payload — the daemon's string is this renderer's string", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      // A frozen clock so the two reads describe the same instant: purity is the
      // claim under test, and a moving clock would test the clock instead.
      clock: () => "2026-07-29T01:00:05.000Z",
      memorySampler: () => ({ "w-1": 512 * MB, "w-2": 128 * MB }),
    });
    running.push(daemon);
    daemon.trackWorker(worker());
    daemon.trackWorker(worker({
      worker_id: "w-2",
      project_label: "acme/gadgets",
      pid: 4343,
      workspace_path: "/tmp/acme/w-2",
      unit: "red-worker-acme-gadgets-w-2.service",
      budget: { memory_max: "512M" },
    }));

    const asked = options({ mode: "global", project: "acme/widgets" });
    const payload = await readRedskilledStatuslinePayload(paths, { sessionProject: "acme/widgets" });
    const render = await readRedskilledStatuslineString(paths, asked, { sessionProject: "acme/widgets" });

    expect(isRedskilledStatuslineRender(render)).toBe(true);
    expect(render.line).toBe(renderRedskilledStatusline(payload, asked).line);
    expect(render.generated_at).toBe(payload.generated_at);
  });

  it("defaults to the local project's Workers and names no other project", () => {
    const payload = payloadOf(
      [worker(), worker({ worker_id: "w-2", project_label: "acme/gadgets", pid: 43 })],
      { "w-1": 512 * MB, "w-2": 128 * MB },
    );

    const render = renderRedskilledStatusline(payload, options({ project: "acme/widgets" }));

    expect(render.mode).toBe("local");
    expect(render.line).toContain("acme/widgets 1w");
    expect(render.line).toContain("w-1 512M/1G");
    expect(render.line).not.toContain("w-2");
    expect(render.line).not.toContain("acme/gadgets");
  });

  it("lists every project's Workers in `global`, each showing its owner", () => {
    const payload = payloadOf(
      [worker(), worker({ worker_id: "w-2", project_label: "acme/gadgets", pid: 43, budget: { memory_max: "512M" } })],
      { "w-1": 512 * MB, "w-2": 128 * MB },
    );

    const render = renderRedskilledStatusline(payload, options({ mode: "global", project: "acme/widgets" }));

    expect(render.detail).toBe("workers");
    expect(render.line).toContain("host 2w/2p");
    expect(render.line).toContain("acme/widgets:w-1 512M/1G");
    expect(render.line).toContain("acme/gadgets:w-2 128M/512M");
  });

  it("degrades a crowded global view to an aggregate and never overflows the line", () => {
    const workers = crowdedWorkers(6);
    const payload = payloadOf(workers, Object.fromEntries(workers.map((w) => [w.worker_id, 256 * MB])));

    const perProject = renderRedskilledStatusline(
      payload,
      options({ mode: "global", maxWorkers: 3, maxProjects: 6, maxWidth: 400 }),
    );
    expect(perProject.detail).toBe("projects");
    expect(perProject.degraded).toBe(true);
    expect(perProject.line).toContain("acme/project-with-a-long-name-0 1w 256M");
    expect(perProject.line).not.toContain(":w-0");

    // Narrow enough that even the per-project aggregate cannot fit: the line
    // drops to the host total rather than printing half a project.
    const hostOnly = renderRedskilledStatusline(
      payload,
      options({ mode: "global", maxWorkers: 3, maxProjects: 6, maxWidth: 40 }),
    );
    expect(hostOnly.detail).toBe("host");
    expect(hostOnly.line).toBe("host 6w/6p 1.5G");
    expect([...hostOnly.line].length).toBeLessThanOrEqual(40);
  });

  it("never exceeds the declared width, at any width", () => {
    const workers = crowdedWorkers(9);
    const payload = payloadOf(workers, Object.fromEntries(workers.map((w) => [w.worker_id, 128 * MB])));

    for (const maxWidth of [5, 12, 40, 80, 200]) {
      for (const mode of ["local", "global"] as const) {
        const render = renderRedskilledStatusline(
          payload,
          options({ mode, project: workers[0].project_label, maxWidth, maxProjects: 9, maxWorkers: 9 }),
        );
        expect([...render.line].length).toBeLessThanOrEqual(maxWidth);
      }
    }
  });

  it("says a Worker is unmeasured rather than showing it as idle", () => {
    const payload = payloadOf([worker()], {});
    const render = renderRedskilledStatusline(payload, options({ project: "acme/widgets" }));
    expect(render.line).toContain("w-1 ?");
    expect(render.line).not.toContain("w-1 0B");
  });

  it("marks a stale answer, and calls an idle host neither stale nor busy", () => {
    const stale = payloadOf([worker()], { "w-1": 64 * MB }, { now: "2026-07-29T01:01:00.000Z" });
    expect(renderRedskilledStatusline(stale, options({ project: "acme/widgets" })).stale).toBe(true);
    expect(renderRedskilledStatusline(stale, options({ project: "acme/widgets" })).line).toContain("!stale 60s");

    const idle = payloadOf([], {}, { sampledAt: null });
    const render = renderRedskilledStatusline(idle, options({ project: "acme/widgets" }));
    expect(render.stale).toBe(false);
    expect(render.line).toBe("acme/widgets 0w 0B idle");
  });
});

describe("the statusline config block", () => {
  const config = [
    "plugins:",
    "  dev:",
    "    statusline:",
    "      mode: global",
    "      max_workers: 2",
    "      max_projects: 7",
    "      max_width: 90",
  ].join("\n");

  it("honours declared defaults with no flags passed", () => {
    const resolved = resolveRedskilledStatuslineOptions({ configText: config, project: "acme/widgets" });

    expect(resolved.options).toMatchObject({
      mode: "global",
      project: "acme/widgets",
      maxWorkers: 2,
      maxProjects: 7,
      maxWidth: 90,
    });
    expect(resolved.warnings).toEqual([]);
  });

  it("lets a flag override the config", () => {
    const { flags } = parseRedskilledStatuslineFlags(["local", "--max-width", "60"]);
    const resolved = resolveRedskilledStatuslineOptions({ configText: config, project: "acme/widgets", flags });

    expect(resolved.options.mode).toBe("local");
    expect(resolved.options.maxWidth).toBe(60);
    // Untouched keys keep the declared value rather than reverting to built-ins.
    expect(resolved.options.maxWorkers).toBe(2);
  });

  it("reads the folded `dev.statusline.*` spelling too", () => {
    const folded = ["dev:", "  statusline:", "    mode: global"].join("\n");
    expect(readRedskilledStatuslineConfig(folded).config.mode).toBe("global");
  });

  it("ignores and names a malformed value instead of refusing to render", () => {
    const broken = ["plugins:", "  dev:", "    statusline:", "      mode: sideways", "      max_width: wide"].join("\n");
    const resolved = resolveRedskilledStatuslineOptions({ configText: broken, project: "acme/widgets" });

    expect(resolved.options.mode).toBe(REDSKILLED_STATUSLINE_DEFAULTS.mode);
    expect(resolved.options.maxWidth).toBe(REDSKILLED_STATUSLINE_DEFAULTS.maxWidth);
    expect(resolved.warnings.map((w) => w.reason)).toEqual([
      "expected `local` or `global`",
      "expected a whole number of zero or more",
    ]);
  });

  it("takes no flags at all and still resolves the built-in defaults", () => {
    expect(resolveRedskilledStatuslineOptions().options).toEqual(REDSKILLED_STATUSLINE_DEFAULTS);
  });
});

describe("one renderer, machine-wide", () => {
  // Sources that may legitimately touch the payload: the renderer itself, the
  // daemon that serves both surfaces, the wire contract, the client, and tests.
  const PAYLOAD_CONSUMERS = new Set([
    "apps/redskilled/src/statusline-render.ts",
    "apps/redskilled/src/statusline-payload.ts",
    "apps/redskilled/src/daemon.ts",
    "apps/redskilled/src/protocol.ts",
    "apps/redskilled/src/client.ts",
  ]);

  it("keeps every other surface — every agent host included — on the string", () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    const offenders: string[] = [];

    for (const area of ["apps", "packages", "plugins"]) {
      const dir = join(root, area);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
        const rel = `${area}/${entry.split(sep).join("/")}`;
        if (!/\.(ts|mts|mjs|js)$/.test(rel)) continue;
        if (rel.includes("/node_modules/") || rel.includes("/dist/") || rel.includes("/tests/")) continue;
        if (PAYLOAD_CONSUMERS.has(rel)) continue;
        const file = join(root, rel);
        if (!statSync(file).isFile()) continue;
        // The MODULE, not the op name: `"statusline-payload"` as a wire verb is
        // a string every reach table may hold; importing the module is what
        // gives a surface the structure to render from.
        if (/statusline-payload\.js/.test(readFileSync(file, "utf8"))) offenders.push(rel);
      }
    }

    // A surface importing the payload is a surface that can build its own line;
    // the tool returns a finished string precisely so none of them needs to.
    expect(offenders).toEqual([]);
  });
});

describe("the host's whole job", () => {
  it("is one command that prints the daemon's line, config-resolved on the client side", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      clock: () => "2026-07-29T01:00:05.000Z",
      memorySampler: () => ({ "w-1": 512 * MB }),
    });
    running.push(daemon);
    daemon.trackWorker(worker());
    await daemon.sampleMemoryBudgets();

    const cwd = await scratch("redskilled-statusline-project-");
    await mkdir(join(cwd, ".red"), { recursive: true });
    await writeFile(
      join(cwd, ".red", "config.yaml"),
      ["project:", "  name: acme/widgets", "plugins:", "  dev:", "    statusline:", "      mode: global", ""].join("\n"),
      "utf8",
    );

    const written: string[] = [];
    const code = await runStatusline([], {
      cwd,
      paths,
      write: (line) => written.push(line),
      warn: () => undefined,
    });

    expect(code).toBe(0);
    expect(written).toHaveLength(1);
    // The config declared `global`; the host passed no flag and still gets it,
    // and the owning project rides on the Worker.
    expect(written[0]).toContain("host 1w/1p");
    expect(written[0]).toContain("acme/widgets:w-1 512M/1G");
    expect(written[0].endsWith("\n")).toBe(true);
  });
});
