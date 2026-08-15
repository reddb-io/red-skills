import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(__dirname, "..", "src");

describe("the ACP control-plane module boundary", () => {
  it("keeps the public control plane at or below its headroom target", async () => {
    const source = await readFile(join(sourceRoot, "acp-control-plane.ts"), "utf8");

    expect(source.split("\n").length - 1).toBeLessThanOrEqual(700);
  });

  it("keeps compatibility negotiation and socket plumbing in domain modules", async () => {
    const [controlPlane, compatibility, socket] = await Promise.all([
      readFile(join(sourceRoot, "acp-control-plane.ts"), "utf8"),
      readFile(join(sourceRoot, "acp-compat.ts"), "utf8"),
      readFile(join(sourceRoot, "acp-socket.ts"), "utf8"),
    ]);

    expect(controlPlane).toContain('from "./acp-compat.js"');
    expect(controlPlane).toContain('from "./acp-socket.js"');
    expect(compatibility).toContain("requireCompatibleWireMajor");
    expect(socket).toContain("connectWithDeadline");
  });
});
