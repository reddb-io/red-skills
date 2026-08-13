import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveServeGithubCompanions } from "../src/github-companions.js";
import { readRedskilledHostGithubApp } from "../src/host-config.js";

/**
 * The App was a payer nobody measured.
 *
 * `balance.toon` and `balance-history.toonl` were written by ONE process — the
 * host daemon — asking on ONE credential, the operator's token. The App's bucket
 * was spent entirely by other processes, so an installation could carry
 * thousands of reads an hour and appear on no surface: the snapshot measured the
 * person, every history row was stamped `pat`, and
 * `balance-app-<installation>.toon` was named in the contract and written by
 * nobody. Redwall plotted a single sawtooth and called it the machine.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempHome(block: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "redskilled-host-"));
  roots.push(home);
  mkdirSync(join(home, ".red"), { recursive: true });
  writeFileSync(
    join(home, ".red", "config.yaml"),
    ["plugins:", "  dev:", "    redskilled:", "      worker_ceiling: 6", ...(block ? [block] : [])]
      .join("\n"),
  );
  return home;
}

const DECLARED = [
  "      github_app:",
  '        app_id: "4575633"',
  '        installation_id: "153309957"',
  "        private_key: ~/.red/redskilled/github-app.pem",
].join("\n");

describe("the daemon reads the App this host declares", () => {
  it("resolves the declared block and expands its home-relative key path", async () => {
    const home = tempHome(DECLARED);
    const app = await readRedskilledHostGithubApp(home);

    expect(app).not.toBeNull();
    expect(app?.appId).toBe("4575633");
    expect(app?.installationId).toBe("153309957");
    expect(app?.privateKeyPath).toBe(join(home, ".red", "redskilled", "github-app.pem"));
  });

  it("answers null for a host that declares none, leaving today's behaviour exactly as it was", async () => {
    expect(await readRedskilledHostGithubApp(tempHome(null))).toBeNull();
  });

  it("answers null for a PARTIAL block instead of refusing to boot", async () => {
    // The dev runtime refuses a partial declaration loudly, because a silent
    // fallback there restores the shared personal bucket the App was adopted to
    // end. Here the App is only a measurement, and a daemon that would not serve
    // a host over an optional number trades the machine for a graph.
    const home = tempHome(['      github_app:', '        app_id: "4575633"'].join("\n"));
    expect(await readRedskilledHostGithubApp(home)).toBeNull();
  });
});

describe("two buckets are measured apart", () => {
  const app = { appId: "4575633", installationId: "153309957", privateKeyPath: "/k.pem" };

  it("gives the App its own snapshot file, never the personal one", () => {
    const [companion] = resolveServeGithubCompanions(app, "/state", {});

    expect(companion?.identity).toBe("app:153309957");
    // A single document would have to pick an owner, and the last writer would
    // become the displayed truth for a ceiling the next request may not use.
    expect(companion?.store).toBeDefined();
    expect(companion?.history).toBeDefined();
    expect(companion?.transport).toBeTypeOf("function");
  });

  it("stamps the App's rows so one shared history holds two separable series", () => {
    const [companion] = resolveServeGithubCompanions(app, "/state", {});
    // The lane is shared on purpose — one curve file, two labelled series — so a
    // consumer plotting the machine separates them by identity rather than by
    // guessing which file was current.
    expect(companion?.identity).toBe("app:153309957");
  });
});
