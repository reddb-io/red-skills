// The daemon asks the token what it has left — ONE poller, host-wide, on a
// cadence the balance itself chooses (ADR 0132 Amendment 2, #3095). It stores the
// answer without interpreting it, never invents a full budget for a balance
// nobody asked for, and puts the posture on the payload so "the queue looks
// empty" and "we are out of quota" are never the same screen.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GITHUB_RATE_LIMIT_PATH, createGithubBalanceTransport } from "@reddb-io/github";
import { afterEach, describe, expect, it } from "vitest";

import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { renderRedskilledDashboard } from "@reddb-io/redskilled-render";
import { renderRedskilledStatusline } from "@reddb-io/redskilled-render";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { isRedskilledStatuslinePayload } from "../src/statusline-payload.js";

let daemons: RedskilledDaemon[] = [];
let dirs: string[] = [];

afterEach(async () => {
  for (const daemon of daemons) await daemon.stop().catch(() => undefined);
  daemons = [];
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function paths(): Promise<RedskilledPaths> {
  const dir = await mkdtemp(join(tmpdir(), "redskilled-balance-"));
  dirs.push(dir);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${dir}`, REDSKILLED_MACHINE_DIR: dir },
    runtimeDir: dir,
  });
}

function answer(remaining: number, limit = 5000): unknown {
  const reset = Math.floor(Date.parse("2026-08-03T13:00:00.000Z") / 1000);
  return {
    resources: {
      core: { limit: 5000, remaining: 5000, used: 0, reset },
      graphql: { limit, remaining, used: limit - remaining, reset },
      search: { limit: 30, remaining: 30, used: 0, reset },
    },
  };
}

async function start(options: Parameters<typeof startRedskilledDaemon>[0]): Promise<RedskilledDaemon> {
  const daemon = await startRedskilledDaemon(options);
  daemons.push(daemon);
  return daemon;
}

describe("one poller, and the balance comes from the token", () => {
  it("asks once per poll and stores what the token answered", async () => {
    let asks = 0;
    const daemon = await start({
      paths: await paths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      githubBalance: {
        transport: async () => {
          asks += 1;
          return answer(2200);
        },
        intervalMsOverride: 3_600_000,
      },
    });

    const balance = await daemon.pollGithubBalance();

    // One ask armed the poller at start, one more from the explicit poll.
    expect(asks).toBe(2);
    expect(balance?.origin).toBe("asked");
    expect(balance?.pools.graphql?.remaining).toBe(2200);
    expect(daemon.githubBalance()?.pools.graphql?.remaining).toBe(2200);
  });

  it("reports unknown — never full — when nothing armed the poller", async () => {
    const daemon = await start({ paths: await paths(), ceiling: UNBOUNDED_HOST_CEILING, sampleMs: 0 });

    expect(await daemon.pollGithubBalance()).toBeNull();
    expect(daemon.githubBalance()).toBeNull();

    const payload = daemon.statuslinePayload();
    expect(payload.github_balance.posture).toBe("unknown");
    expect(payload.github_balance.asked_at).toBeNull();
    expect(payload.github_balance.reason).toContain("unknown rather than full");
  });

  it("keeps a refusal from passing for a healthy budget", async () => {
    const daemon = await start({
      paths: await paths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      githubBalance: {
        transport: async () => {
          throw new Error("the balance ask was refused with HTTP 401");
        },
        intervalMsOverride: 3_600_000,
      },
    });

    const balance = await daemon.pollGithubBalance();

    expect(balance?.outcome).toBe("unanswered");
    expect(balance?.pools.graphql).toBeNull();
    expect(daemon.statuslinePayload().github_balance.posture).toBe("unknown");
  });
});

describe("the breaker's state is on the payload", () => {
  it("separates a spent quota from an empty queue on one screen", async () => {
    const daemon = await start({
      paths: await paths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      githubBalance: { transport: async () => answer(0), intervalMsOverride: 3_600_000 },
    });

    await daemon.pollGithubBalance();
    const payload = daemon.statuslinePayload();

    expect(isRedskilledStatuslinePayload(payload)).toBe(true);
    expect(payload.github_balance.posture).toBe("spent");
    expect(payload.github_balance.reason).toContain("refused");
    // The counts say nothing at all, which is exactly why the posture must.
    expect(payload.repository_activity.projects).toEqual([]);
  });

  it("enters the graduated posture at a threshold, not at a 403", async () => {
    const daemon = await start({
      paths: await paths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      githubBalance: { transport: async () => answer(100), intervalMsOverride: 3_600_000 },
    });

    await daemon.pollGithubBalance();
    const balance = daemon.statuslinePayload().github_balance;

    expect(balance.posture).toBe("reserved");
    expect(balance.reserved_fraction).toBeGreaterThan(0);
    expect(balance.age_ms).not.toBeNull();
    expect(balance.next_poll_ms).toBeGreaterThan(0);
  });

  it("dates the balance so a surface renders the age instead of inventing it", async () => {
    const instants = ["2026-08-03T12:00:00.000Z", "2026-08-03T12:00:20.000Z", "2026-08-03T12:00:20.000Z"];
    let index = 0;
    const daemon = await start({
      paths: await paths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      clock: () => instants[Math.min(index++, instants.length - 1)]!,
      githubBalance: { transport: async () => answer(4000), intervalMsOverride: 3_600_000 },
    });

    await daemon.pollGithubBalance();
    const balance = daemon.statuslinePayload().github_balance;

    expect(balance.asked_at).not.toBeNull();
    expect(balance.age_ms).not.toBeNull();
  });
});

describe("the ask reaches the authoritative endpoint", () => {
  it("issues a single GET against /rate_limit under the host token", async () => {
    const seen: { url: string; method: string | undefined }[] = [];
    const transport = createGithubBalanceTransport({
      token: "t0ken",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seen.push({ url: String(url), method: init?.method });
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => answer(4900),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });

    const payload = await transport();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain(`/${GITHUB_RATE_LIMIT_PATH}`);
    expect(seen[0]!.method).toBe("GET");
    expect(payload).toBeTruthy();
  });
});

describe("an empty queue and a spent quota are not the same screen", () => {
  async function render(remaining: number) {
    const daemon = await start({
      paths: await paths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      githubBalance: { transport: async () => answer(remaining), intervalMsOverride: 3_600_000 },
    });
    await daemon.pollGithubBalance();
    const payload = daemon.statuslinePayload();
    return {
      statusline: renderRedskilledStatusline(payload).line,
      dashboard: renderRedskilledDashboard(payload).lines.join("\n"),
    };
  }

  it("marks a spent budget on the statusline and explains it on the dashboard", async () => {
    const spent = await render(0);

    expect(spent.statusline).toContain("quota spent");
    expect(spent.dashboard).toContain("github budget spent");
    expect(spent.dashboard).toContain("resets at");
  });

  it("marks the reserved band differently from a spent budget", async () => {
    const band = await render(100);

    expect(band.statusline).toContain("quota band");
    expect(band.statusline).not.toContain("quota spent");
    expect(band.dashboard).toContain("github budget reserved");
  });

  it("says nothing at all while the budget is open", async () => {
    const open = await render(5000);

    expect(open.statusline).not.toContain("quota");
    expect(open.dashboard).not.toContain("github budget");
  });
});
