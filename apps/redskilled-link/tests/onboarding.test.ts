import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeInvitation } from "@reddb-io/red-skills-link-protocol/crypto";
import { runRedskilledLinkOnboarding } from "../src/onboarding.js";
import { currentRedskilledLinkEntry, planRedskilledLinkUnit } from "../src/supervision.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("redskilled link onboarding", () => {
  it("persists Host configuration, installs supervision, and emits URI plus manual code", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-link-onboarding-"));
    roots.push(root);
    const state = join(root, "state.toon");
    const writes: string[] = [];
    const unitWrites: Array<{ path: string; text: string }> = [];
    const run = vi.fn(() => ({ status: 0 }));
    const showQr = vi.fn(async () => false);
    const code = await runRedskilledLinkOnboarding([
      "--relay", "wss://relay.example", "--name", "Desk", "--state", state,
    ], {
      entry: { command: "/usr/bin/node", args: ["/opt/redskilled-link.bundle.min.mjs"] },
      unitIO: {
        write: async (path, text) => { unitWrites.push({ path, text }); },
        run,
      },
      showQr,
      write: (value) => { writes.push(value); },
    });

    expect(code).toBe(0);
    expect(run.mock.calls).toEqual([
      [["systemctl", "--user", "daemon-reload"]],
      [["systemctl", "--user", "enable", "redskilled-link.service"]],
      [["systemctl", "--user", "restart", "redskilled-link.service"]],
    ]);
    expect(unitWrites[0]!.text).toContain(`"host" "--state" "${state}"`);
    expect(await readFile(state, "utf8")).toContain("relay_url");
    const output = writes.join("");
    const uri = /Connection URI: (redskilled:\/\/pair\/\S+)/.exec(output)?.[1];
    const manual = /Manual code: (\S+)/.exec(output)?.[1];
    expect(uri).toBeDefined();
    expect(manual).toBeDefined();
    expect(decodeInvitation(uri!)).toEqual(decodeInvitation(manual!));
    expect(showQr).toHaveBeenCalledWith(uri, expect.any(String));
  });

  it("reuses the persisted relay when no relay flag is supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-link-reuse-"));
    roots.push(root);
    const state = join(root, "state.toon");
    const common = {
      entry: { command: "/usr/bin/node", args: ["/opt/redskilled-link.bundle.min.mjs"] },
      unitIO: { write: async () => undefined, run: () => ({ status: 0 }) },
      showQr: async () => false,
      write: () => undefined,
    };
    await runRedskilledLinkOnboarding(["--relay", "wss://relay.example", "--state", state], common);
    await expect(runRedskilledLinkOnboarding(["--state", state], common)).resolves.toBe(0);
  });

  it("states that WireGuard is unavailable without opening the wrong device settings", async () => {
    const writes: string[] = [];
    await expect(runRedskilledLinkOnboarding(["--transport", "wireguard"], {
      write: (value) => { writes.push(value); },
    })).resolves.toBe(2);
    expect(writes.join("")).toContain("not available in this build");
    expect(writes.join("")).toContain("opening this PC's VPN settings would not configure the phone");
  });
});

describe("redskilled-link user unit", () => {
  it("copies a cache-resident companion to the durable daemon bin before supervising it", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-link-stable-entry-"));
    roots.push(root);
    const cacheEntry = join(root, "temporary-npx-cache", "redskilled-link.bundle.min.mjs");
    await mkdir(join(root, "temporary-npx-cache"), { recursive: true });
    await writeFile(cacheEntry, "export const bundle = 'one';");

    const entry = currentRedskilledLinkEntry({
      scriptPath: cacheEntry,
      execPath: "/usr/bin/node",
      execArgv: [],
      homeDir: root,
    });

    expect(entry.command).toBe("/usr/bin/node");
    expect(entry.args).toHaveLength(1);
    expect(entry.args[0]).toMatch(new RegExp(`^${root}/\\.red/redskilled/bin/redskilled-link-[a-f0-9]{16}\\.bundle\\.min\\.mjs$`));
    await expect(readFile(entry.args[0]!, "utf8")).resolves.toBe("export const bundle = 'one';");
  });

  it("keeps the companion alive without putting relay credentials in ExecStart", () => {
    const plan = planRedskilledLinkUnit({
      entry: { command: "/usr/bin/node", args: ["/opt/redskilled-link.bundle.min.mjs"] },
      statePath: "/home/tester/.red/redskilled/link/state.toon",
      env: { HOME: "/home/tester" },
    });
    expect(plan.unitPath).toBe("/home/tester/.config/systemd/user/redskilled-link.service");
    expect(plan.text).toContain("Restart=always");
    expect(plan.text).toContain('"host" "--state"');
    expect(plan.text).not.toContain("wss://");
  });
});
