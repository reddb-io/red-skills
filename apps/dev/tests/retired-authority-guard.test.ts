import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

const RETIRED_IMPLEMENTATIONS = [
  "apps/dev/scripts/castle-session-diagnostic.ts",
  "apps/dev/src/castle-resident.ts",
  "apps/dev/src/mcp-adapter.ts",
  "apps/dev/src/mcp/dependencies.ts",
  "apps/dev/src/mcp/events.ts",
  "apps/dev/src/mcp/handlers.ts",
  "apps/dev/src/mcp/operations.ts",
  "apps/dev/src/mcp/project.ts",
  "apps/dev/src/mcp/queue.ts",
  "apps/dev/src/mcp/vitals.ts",
  "apps/dev/src/resident-authority.ts",
  "apps/dev/src/resident-cron.ts",
  "apps/dev/src/resident-read-cache.ts",
  "apps/dev/src/resident-self-update.ts",
  "apps/dev/src/resident-unblock.ts",
  "apps/dev/src/resident-webhook.ts",
  "apps/dev/src/runtime/etag-transport.ts",
  "apps/redskilled/src/demand-producer.ts",
  "apps/redskilled/src/interactive-reservation.ts",
  "apps/redskilled/src/project-breaker.ts",
  "packages/worker/src/resident.ts",
] as const;

const ACTIVE_ROOTS = ["apps/dev/src", "apps/redskilled/src", "packages/worker/src"] as const;
const SOURCE_SUFFIXES = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const PRIVATE_WIRE =
  /@reddb-io\/(?:red-castle|worker)\/resident|sendCastleResidentRequest|CastleResidentClient|startCastleResident/;

describe("retired workflow authorities stay deleted", () => {
  it("leaves redskilled as the only live control-plane owner", () => {
    expect(existsSync(join(ROOT, "apps/redskilled/src/daemon/lifecycle.ts"))).toBe(true);
    for (const path of RETIRED_IMPLEMENTATIONS) {
      expect(existsSync(join(ROOT, path)), `${path} is a retired authority`).toBe(false);
    }
  });

  it("exposes neither the Castle resident wire nor the Demand producer", () => {
    const castle = JSON.parse(readFileSync(join(ROOT, "packages/worker/package.json"), "utf8"));
    const redskilled = JSON.parse(readFileSync(join(ROOT, "apps/redskilled/package.json"), "utf8"));
    expect(castle.exports).not.toHaveProperty("./resident");
    expect(redskilled.exports).not.toHaveProperty("./demand-producer");
  });

  it("keeps active source off the private adapter-to-daemon protocol", () => {
    const violations = ACTIVE_ROOTS.flatMap((root) => sourceFiles(join(ROOT, root)))
      .filter((path) => PRIVATE_WIRE.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path).split(sep).join("/"));
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return entry.name === "tests" ? [] : sourceFiles(path);
    return SOURCE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)) ? [path] : [];
  });
}
