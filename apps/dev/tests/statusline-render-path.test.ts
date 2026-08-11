import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { directCollector, localGit, probeStatusline, spawned } = vi.hoisted(() => ({
  directCollector: vi.fn(() => {
    throw new Error("the render path called a project collector");
  }),
  /** Every command the render path tried to run, whatever the spawn shape. */
  spawned: [] as string[],
  // The bedrock's ONE collector: local git under its micro-TTL. Zero network,
  // zero daemon — the membership rule of the segment (ADR 0141 §1), so it is the
  // one reach the render path is allowed to make.
  localGit: vi.fn(async () => ({
    basename: "red-skills",
    branch: "afk/3563-bedrock",
    localAdded: 142,
    localRemoved: 36,
  })),
  probeStatusline: vi.fn(async () => ({
    payload: {
      generated_at: "2026-08-11T12:00:00.000Z",
      staleness: { age_ms: 5_000, threshold_ms: 30_000, stale: false },
    },
    render: {
      lines: [
        "acme/widgets 1w 128M v3.12.10",
        "w123  ███▶░░  run=codex gpt-5.6 xhigh  iss=3546  implementing·tests  00:02:03  loc=+12 -3  tks=45k  tls=9 rsn=2 txt=1",
      ],
      mode: "local",
      project_match: "matched",
    },
  })),
}));

vi.mock("@reddb-io/redskilled/statusline-command", () => ({ probeStatusline }));

// Every process this render could start, recorded rather than run. The counters
// are the daemon's (ADR 0141 decision 2) and the local count caches are deleted,
// so a `gh` here would be a network client back in front of a terminal prompt —
// the #3546 regression, wearing a new source.
vi.mock("node:child_process", () => {
  const record = (command: string) => {
    spawned.push(command);
    throw new Error(`the render path spawned a subprocess: ${command}`);
  };
  return {
    spawn: (command: string) => record(command),
    spawnSync: (command: string) => record(command),
    exec: (command: string) => record(command),
    execFile: (command: string) => record(command),
    execFileSync: (command: string) => record(command),
    execSync: (command: string) => record(command),
    fork: (command: string) => record(command),
  };
});

vi.mock("../src/runtime/wire.js", () => ({
  collectStatuslineLocalGit: localGit,
  resolveRepoBasename: directCollector,
  collectStatuslineAfk: directCollector,
  collectStatuslineDocs: directCollector,
  collectStatuslineFleet: directCollector,
  collectStatuslineValidationGate: directCollector,
  collectStatuslineWorkers: directCollector,
  inferGitHubRepoSlug: directCollector,
}));

import { statuslineCommand } from "../src/commands/statusline.js";
import { readBuildInfo } from "@reddb-io/build-info";

const PAYLOAD = {
  model: { display_name: "Opus" },
  effort: { level: "high" },
  context_window: { total_input_tokens: 47_000, used_percentage: 24 },
  rate_limits: { five_hour: { used_percentage: 23 }, seven_day: { used_percentage: 41 } },
};

const roots: string[] = [];
const cacheDir = process.env.RED_SKILLS_CACHE_DIR;

beforeEach(async () => {
  // An empty bundle cache, so the bedrock's version label is the build stamp
  // alone: the developer's own `~/.cache` must not decide whether the rendered
  // line carries the newer-bundle `*`.
  const empty = await mkdtemp(join(tmpdir(), "statusline-render-path-cache-"));
  roots.push(empty);
  process.env.RED_SKILLS_CACHE_DIR = empty;
});

afterEach(async () => {
  vi.clearAllMocks();
  spawned.length = 0;
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

describe("dev statusline render path", () => {
  it("renders the daemon document without invoking a project collector or API client", async () => {
    const root = await mkdtemp(join(tmpdir(), "statusline-render-path-"));
    roots.push(root);
    const out = sink();

    const started = performance.now();
    const code = await statuslineCommand(
      [root, "global", "--verbose", "--no-workers"],
      root,
      out.stream,
      fakeStdin(JSON.stringify({ workspace: { project_dir: root } })),
    );
    const adapterMs = performance.now() - started;

    expect(code).toBe(0);
    expect(probeStatusline).toHaveBeenCalledOnce();
    expect(probeStatusline).toHaveBeenCalledWith(
      ["global", "--verbose"],
      expect.objectContaining({ cwd: root, client: { requestTimeoutMs: 150 } }),
    );
    expect(directCollector).not.toHaveBeenCalled();
    // The bedrock LEADS the daemon's header line; the Worker lines follow it
    // untouched.
    expect(out.text().split("\n")[0]).toContain(" · acme/widgets 1w 128M v3.12.10");
    expect(out.text()).toContain("run=codex gpt-5.6 xhigh");
    expect(out.text()).toContain("iss=3546");
    expect(out.text()).toContain("loc=+12 -3  tks=45k  tls=9 rsn=2 txt=1");
    // Repro baseline from #3546: daemon read 0.53s; old dev render 7.03–8.08s.
    // The adapter adds less than 100ms in-process, keeping total render time in
    // the daemon read's order of magnitude while leaving socket time measurable
    // in the daemon client rather than hiding it behind tracker subprocesses.
    expect(adapterMs).toBeLessThan(100);
  });

  it("prints the bedrock-only lifecycle promptly without a tracker fallback", async () => {
    probeStatusline.mockRejectedValueOnce(new Error("socket unavailable"));
    const root = await mkdtemp(join(tmpdir(), "statusline-render-path-"));
    roots.push(root);
    const out = sink();

    const started = performance.now();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(""));

    expect(code).toBe(0);
    expect(out.text()).toContain("rsk=bedrock-only");
    expect(directCollector).not.toHaveBeenCalled();
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("renders the bedrock COMPLETE under a daemon-absent fixture", async () => {
    // The daemon answers nothing at all — not even an absence line. Everything
    // the operator's own machine holds must still reach the screen: model·effort
    // and context and the subscription windows from stdin, basename/branch/diff
    // from local git, and the running bundle version (ADR 0141 §1).
    probeStatusline.mockRejectedValueOnce(new Error("socket unavailable"));
    const root = await mkdtemp(join(tmpdir(), "statusline-render-path-"));
    roots.push(root);
    const out = sink();

    const code = await statuslineCommand([root], root, out.stream, fakeStdin(JSON.stringify(PAYLOAD)));

    expect(code).toBe(0);
    expect(out.text()).toBe(
      `red-skills (afk/3563-bedrock) v${readBuildInfo("dev").version} · Opus·high · 47k 24% · ` +
        "5h=23% 7d=41% · loc=+142 -36 · rsk=bedrock-only\n",
    );
    expect(localGit).toHaveBeenCalledOnce();
    expect(directCollector).not.toHaveBeenCalled();
  });

  it("still renders the bedrock when the daemon probe fails", async () => {
    probeStatusline.mockRejectedValueOnce(new Error("socket unavailable"));
    const root = await mkdtemp(join(tmpdir(), "statusline-render-path-"));
    roots.push(root);
    const out = sink();

    const code = await statuslineCommand([root], root, out.stream, fakeStdin(JSON.stringify(PAYLOAD)));

    expect(code).toBe(0);
    expect(out.text()).toBe(
      `red-skills (afk/3563-bedrock) v${readBuildInfo("dev").version} · Opus·high · 47k 24% · ` +
        "5h=23% 7d=41% · loc=+142 -36 · rsk=bedrock-only\n",
    );
  });

  it("spawns no gh subprocess on any render path — the count caches are gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "statusline-render-path-"));
    roots.push(root);

    // Daemon answering, daemon silent, daemon stating its absence: all three are
    // render paths, and none of them may reach a tracker client.
    probeStatusline.mockRejectedValueOnce(new Error("socket unavailable"));
    await statuslineCommand([root], root, sink().stream, fakeStdin(JSON.stringify(PAYLOAD)));
    probeStatusline.mockRejectedValueOnce(new Error("socket unavailable"));
    await statuslineCommand([root], root, sink().stream, fakeStdin("{}"));
    await statuslineCommand([root, "global"], root, sink().stream, fakeStdin("{}"));

    expect(spawned).toEqual([]);
    expect(directCollector).not.toHaveBeenCalled();
  });

  it("no longer ships the local count caches or their refresher", async () => {
    // The pin above proves no subprocess ran; this proves there is nothing left
    // to run one — the surface is deleted, not shrunk (no-legacy).
    // The REAL module, not this file's mock of it: the claim is about what the
    // barrel exports, and a mock would answer for itself.
    const wire = await vi.importActual<Record<string, unknown>>("../src/runtime/wire.js");
    for (const gone of [
      "collectStatuslineRepo",
      "refreshStatuslineCountCache",
      "refreshStatuslineRepoCache",
      "resolveStatuslineCacheTtl",
      "statuslineCountCachePath",
      "editLabelsWithStatuslineCache",
      "startDetachedStatuslineCountRefresh",
    ]) {
      expect(gone in wire, `${gone} still exists`).toBe(false);
    }
    const command = await vi.importActual<Record<string, unknown>>(
      "../src/commands/statusline.js",
    );
    expect("statuslineRefreshCountsCommand" in command).toBe(false);
  });
});
