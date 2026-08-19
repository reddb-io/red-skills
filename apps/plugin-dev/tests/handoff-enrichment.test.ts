import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  buildHandoffEnrichment,
  type HandoffEnrichmentDeps,
} from "../src/core/handoff-enrichment.js";
import { buildHandoff } from "../src/core/handoff.js";

const CONTEXT_MAP = `# Context Map

## Contexts

- [Dev](./contexts/dev/CONTEXT.md) - engineering workflow plugin: issue triage,
  AFK execution, handoffs, and branch safety.
- [Memory](./contexts/memory/CONTEXT.md) - persistent project memory plugin:
  graph recall, evidence, and codebase mapping.
`;

const DEV_GLOSSARY = `# Dev

## Language

**Handoff**:
The bounded worker brief assembled before AFK execution.
_Avoid_: prompt dump

**Branch lock**:
A local pin that prevents branch switching.
_Avoid_: checkout guard

**Unrelated ceremony**:
A term that should not match this issue.
`;

const MEMORY_GLOSSARY = `# Memory

## Language

**Graph recall**:
Retrieval of cited project evidence.
`;

function deps(overrides: Partial<HandoffEnrichmentDeps> = {}): HandoffEnrichmentDeps {
  const files: Record<string, string> = {
    ".red/CONTEXT-MAP.md": CONTEXT_MAP,
    ".red/contexts/dev/CONTEXT.md": DEV_GLOSSARY,
    ".red/contexts/memory/CONTEXT.md": MEMORY_GLOSSARY,
  };
  return {
    readText: async (path) => files[path] ?? "",
    gitLog: async () => "",
    ...overrides,
  };
}

describe("AFK handoff enrichment", () => {
  it("resolves the owning context and selects only glossary entries relevant to issue fixtures", async () => {
    const rendered = await buildHandoffEnrichment(
      {
        title: "Enrich the AFK handoff",
        body: "Update `apps/plugin-dev/src/core/handoff.ts` for Spec #22.",
        labels: ["plugin:dev", "type:task", "spec:22"],
        specRef: "22",
      },
      deps(),
    );

    const payload = decode(rendered) as {
      context: { name: string; glossary_path: string };
      glossary_terms: Array<{ term: string; definition: string; avoid?: string }>;
    };
    expect(payload.context).toEqual({
      name: "Dev",
      glossary_path: ".red/contexts/dev/CONTEXT.md",
    });
    expect(payload.glossary_terms).toEqual([
      {
        term: "Handoff",
        definition: "The bounded worker brief assembled before AFK execution.",
        avoid: "prompt dump",
      },
    ]);
    expect(rendered).not.toContain("Unrelated ceremony");
    expect(rendered).not.toContain("Graph recall");
  });

  it("matches context-map language across simple singular and plural forms", async () => {
    const rendered = await buildHandoffEnrichment(
      {
        title: "AFK handoff enrichment",
        body: "Resolve ownership through `.red/CONTEXT-MAP.md` for Spec #22.",
        labels: ["type:task", "spec:22"],
        specRef: "22",
      },
      deps(),
    );

    expect((decode(rendered) as { context: { name: string } }).context.name).toBe("Dev");
  });

  it("discovers at most two recent path-local PR exemplars and stays within the byte budget", async () => {
    const separator = "\u001e";
    const field = "\u001f";
    const fakeLog = [
      ["a1", "Tighten handoff framing (#103)", "Shows the current XML boundary."].join(field),
      ["a2", "Merge pull request #102 from topic", "Keep enrichment best effort."].join(field),
      ["a3", "Older handoff refactor (#101)", "Should be excluded by the count cap."].join(field),
    ].join(separator);
    let seenPaths: readonly string[] = [];

    const rendered = await buildHandoffEnrichment(
      {
        title: "Enrich the AFK handoff",
        body: "Touch `apps/plugin-dev/src/core/handoff.ts`.",
        labels: ["plugin:dev"],
      },
      deps({
        gitLog: async (paths) => {
          seenPaths = paths;
          return fakeLog;
        },
      }),
      { maxBytes: 900 },
    );

    const payload = decode(rendered) as {
      exemplars: Array<{ pr: number; title: string; shows: string }>;
    };
    expect(seenPaths).toContain("apps/plugin-dev/src/core/handoff.ts");
    expect(payload.exemplars).toHaveLength(2);
    expect(payload.exemplars.map((entry) => entry.pr)).toEqual([103, 102]);
    expect(payload.exemplars[0]?.shows).toBe("Shows the current XML boundary.");
    expect(rendered).not.toContain("#101");
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(900);
  });

  it("degrades silently to no enrichment when context or git discovery fails", async () => {
    await expect(
      buildHandoffEnrichment(
        {
          title: "Enrich handoff",
          body: "Touch apps/plugin-dev/src/core/handoff.ts.",
          labels: ["plugin:dev"],
        },
        deps({
          readText: async () => {
            throw new Error("context unavailable");
          },
        }),
      ),
    ).resolves.toBe("");
  });

  it("injects the TOON supplement in a named handoff section and omits an empty supplement", () => {
    const input = {
      issue: 2402,
      title: "Enrich handoff",
      body: "Base issue body",
      runner: "codex",
      started: "2026-07-22T00:00:00Z",
      attempt: 1,
      url: "https://example.test/issues/2402",
      comments: [],
    };
    const enriched = buildHandoff({ ...input, enrichment: "context:\n  name: Dev" });
    expect(enriched).toContain("<handoff-enrichment>\ncontext:\n  name: Dev\n</handoff-enrichment>");
    expect(buildHandoff({ ...input, enrichment: "" })).not.toContain("<handoff-enrichment>");
  });
});
