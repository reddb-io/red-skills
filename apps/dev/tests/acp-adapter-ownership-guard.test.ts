import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ADAPTERS = [
  "src/mcp-server.ts",
  "src/project-acp-adapter.ts",
  "../redskilled/src/acp-client.ts",
] as const;

const FORBIDDEN = [
  { pattern: /red-castle\/resident/, owner: "adapter-owned resident protocol" },
  { pattern: /runtime\/gh(?:\.js)?["']/, owner: "adapter-owned GitHub client" },
  { pattern: /mcp-worker-birth/, owner: "adapter-owned Worker birth" },
  { pattern: /sendRedskilledRequest/, owner: "private daemon protocol" },
  { pattern: /createProjectControlStore/, owner: "adapter-owned durable Project state" },
] as const;

describe("ACP adapter ownership guard", () => {
  it("keeps public adapters as stateless ACP clients", () => {
    const violations: string[] = [];
    for (const relative of ADAPTERS) {
      const source = readFileSync(resolve(__dirname, "..", relative), "utf8");
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(source)) violations.push(`${relative}: ${rule.owner}`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
