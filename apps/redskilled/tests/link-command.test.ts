import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  REDSKILLED_LINK_BUNDLE_ASSET,
  resolveRedskilledLinkCommand,
  runRedskilledLinkCommand,
} from "../src/link-command.js";

describe("redskilled link front door", () => {
  it("resolves the companion published beside redskilled", () => {
    const directory = "/opt/red-skills/dist";
    const companion = join(directory, REDSKILLED_LINK_BUNDLE_ASSET);
    expect(resolveRedskilledLinkCommand({
      callerEntry: join(directory, "redskilled.bundle.min.mjs"),
      execPath: "/usr/bin/node",
      execArgv: [],
      env: { HOME: "/home/tester" },
      exists: (path) => path === companion,
    })).toEqual({ command: "/usr/bin/node", args: [companion], entry: companion });
  });

  it("hands all operator flags to the companion onboarding command", () => {
    const run = vi.fn(() => ({ status: 0 }));
    const status = runRedskilledLinkCommand(["--relay", "wss://relay.example", "--name", "Desk"], {
      env: { HOME: "/home/tester", REDSKILLED_LINK_BIN: "/opt/bin/redskilled-link" },
      run,
    });
    expect(status).toBe(0);
    expect(run).toHaveBeenCalledWith("/opt/bin/redskilled-link", [
      "onboard", "--relay", "wss://relay.example", "--name", "Desk",
    ]);
  });

  it("fails closed and names every searched location when the companion is absent", () => {
    expect(() => resolveRedskilledLinkCommand({
      callerEntry: "/opt/red-skills/dist/redskilled.bundle.min.mjs",
      env: { HOME: "/home/tester" },
      exists: () => false,
    })).toThrow(/companion is not installed[\s\S]*redskilled-link\.bundle\.min\.mjs/);
  });
});
