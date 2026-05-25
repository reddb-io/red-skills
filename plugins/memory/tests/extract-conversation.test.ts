import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type AiProviderConfig,
  type ExtractedFact,
  type ProviderClient,
  type ProviderRequest,
  buildExtractionPrompt,
  extractConversation,
  extractStructuredTranscript,
  factsToGraph,
  parseExtraction,
  resolveProvider,
} from "../src/extract-conversation.js";

// A deterministic provider stub: returns a canned response and records the
// request it was handed, so tests can assert prompt structure + that the
// transcript reached the model. No network, no engine — this is the seam the
// engine-side AI provider sits behind in production.
function stubClient(response: string): ProviderClient & { last: ProviderRequest | null } {
  return {
    last: null,
    async complete(req: ProviderRequest) {
      this.last = req;
      return response;
    },
  };
}

// Golden fixture: a fixed transcript and the exact provider JSON it elicits.
const TRANSCRIPT = `
user: the deploy kept failing on cold start
assistant: root cause was the connection pool initialising lazily. I moved pool
warm-up into the boot sequence, which fixed the cold-start timeouts.
user: nice — let's keep that pattern for the worker service too
`.trim();

const PROVIDER_JSON = JSON.stringify({
  facts: [
    {
      label: "cold-start-deploy-failure",
      node_type: "problem",
      title: "Deploy failed on cold start",
      summary: "Deploys timed out on cold start due to lazy connection-pool init.",
      tags: ["deploy", "cold-start"],
    },
    {
      label: "warm-pool-in-boot",
      node_type: "fix",
      title: "Warm the connection pool during boot",
      summary: "Move pool warm-up into the boot sequence to remove cold-start timeouts.",
      relations: [{ label: "FIXES", target: "cold-start-deploy-failure" }],
    },
  ],
});

// The exact ExtractedFact[] the golden transcript+response must produce.
const GOLDEN: ExtractedFact[] = [
  {
    label: "cold-start-deploy-failure",
    node_type: "problem",
    title: "Deploy failed on cold start",
    summary: "Deploys timed out on cold start due to lazy connection-pool init.",
    tags: ["deploy", "cold-start"],
    relations: [],
  },
  {
    label: "warm-pool-in-boot",
    node_type: "fix",
    title: "Warm the connection pool during boot",
    summary: "Move pool warm-up into the boot sequence to remove cold-start timeouts.",
    tags: undefined,
    relations: [{ label: "FIXES", target: "cold-start-deploy-failure" }],
  },
];

describe("buildExtractionPrompt", () => {
  test("is deterministic and pins the output schema + transcript", () => {
    const a = buildExtractionPrompt(TRANSCRIPT);
    const b = buildExtractionPrompt(TRANSCRIPT);
    expect(a).toEqual(b); // same input ⇒ same prompt

    expect(a.system).toContain('"facts"');
    expect(a.system).toContain("node_type is one of");
    expect(a.system).toContain("problem");
    expect(a.system).toContain("FIXES");
    expect(a.user).toContain("the deploy kept failing on cold start");
  });

  test("trims the transcript into the user turn", () => {
    const req = buildExtractionPrompt("  hello  ");
    expect(req.user).toBe("Transcript:\n\nhello");
  });
});

describe("extractConversation (golden file)", () => {
  test("fixed transcript + mocked provider → expected ExtractedFact[]", async () => {
    const client = stubClient(PROVIDER_JSON);
    const facts = await extractConversation(TRANSCRIPT, client);
    expect(facts).toEqual(GOLDEN);
    // the transcript actually reached the provider
    expect(client.last?.user).toContain("connection pool");
  });

  test("empty transcript never calls the provider", async () => {
    const client = stubClient(PROVIDER_JSON);
    const facts = await extractConversation("   ", client);
    expect(facts).toEqual([]);
    expect(client.last).toBeNull();
  });

  test("a provider that throws yields no facts (best-effort, never crashes)", async () => {
    const client: ProviderClient = {
      async complete() {
        throw new Error("provider unreachable");
      },
    };
    await expect(extractConversation(TRANSCRIPT, client)).resolves.toEqual([]);
  });
});

describe("extractStructuredTranscript", () => {
  test("extracts explicit engineering facts without a provider", () => {
    const facts = extractStructuredTranscript(`
      user: Problem: deploys fail during cold start.
      assistant: Fix: warm the connection pool during boot.
      assistant: Validation: pnpm test passed for startup.
      user: Decision: keep the warm-pool pattern for worker services.
    `);

    expect(facts.map((fact) => fact.node_type)).toEqual([
      "problem",
      "fix",
      "validation",
      "decision",
    ]);
    expect(facts.map((fact) => fact.label)).toEqual([
      "problem-deploys-fail-during-cold-start",
      "fix-warm-the-connection-pool-during-boot",
      "validation-pnpm-test-passed-for-startup",
      "decision-keep-the-warm-pool-pattern-for-worker-services",
    ]);
    expect(facts[1].relations).toEqual([
      { label: "FIXES", target: "problem-deploys-fail-during-cold-start" },
      { label: "TESTED_BY", target: "validation-pnpm-test-passed-for-startup" },
    ]);
    expect(facts[2].relations).toEqual([]);
  });

  test("ignores free-form transcript lines so local extraction stays conservative", () => {
    expect(extractStructuredTranscript("we should probably remember this later")).toEqual([]);
  });
});

describe("parseExtraction", () => {
  test("tolerates a ```json fence", () => {
    const facts = parseExtraction("```json\n" + PROVIDER_JSON + "\n```");
    expect(facts).toEqual(GOLDEN);
  });

  test("non-JSON yields an empty list", () => {
    expect(parseExtraction("I could not find anything to extract.")).toEqual([]);
  });

  test("drops individual malformed facts but keeps valid ones", () => {
    const raw = JSON.stringify({
      facts: [
        { label: "ok", node_type: "concept", title: "Valid" },
        { label: "bad-type", node_type: "not-a-type", title: "Invalid type" },
        { node_type: "concept", title: "missing label" },
      ],
    });
    const facts = parseExtraction(raw);
    expect(facts.map((f) => f.label)).toEqual(["ok"]);
  });

  test("dedupes facts by label within one response", () => {
    const raw = JSON.stringify({
      facts: [
        { label: "dup", node_type: "concept", title: "First" },
        { label: "dup", node_type: "concept", title: "Second" },
      ],
    });
    expect(parseExtraction(raw)).toHaveLength(1);
  });

  test("drops relations whose target is not an extracted fact", () => {
    const raw = JSON.stringify({
      facts: [
        {
          label: "a",
          node_type: "concept",
          title: "A",
          relations: [
            { label: "REFERENCES", target: "ghost" },
            { label: "REFERENCES", target: "a" },
          ],
        },
      ],
    });
    const [fact] = parseExtraction(raw);
    expect(fact.relations).toEqual([{ label: "REFERENCES", target: "a" }]);
  });
});

describe("resolveProvider (provider-mode selection)", () => {
  test("openai-compat at a loopback host is local (no external egress)", () => {
    const config: AiProviderConfig = {
      mode: "openai-compat",
      model: "llama3.1",
      baseUrl: "http://localhost:11434/v1",
    };
    const resolved = resolveProvider(config);
    expect(resolved.egress).toBe("local");
    expect(resolved.endpoint).toBe("http://localhost:11434/v1");
    expect(resolved.model).toBe("llama3.1");
  });

  test("openai-compat at 127.0.0.1 is local", () => {
    expect(
      resolveProvider({ mode: "openai-compat", model: "m", baseUrl: "http://127.0.0.1:8080/v1" })
        .egress,
    ).toBe("local");
  });

  test("openai-compat at a remote host is external", () => {
    expect(
      resolveProvider({
        mode: "openai-compat",
        model: "m",
        baseUrl: "https://api.together.xyz/v1",
      }).egress,
    ).toBe("external");
  });

  test("openai-compat without a baseUrl is a config error", () => {
    expect(() => resolveProvider({ mode: "openai-compat", model: "m" })).toThrow(/baseUrl/);
  });

  test("native modes are external with no fixed endpoint", () => {
    for (const mode of ["openai-native", "anthropic-native"] as const) {
      const resolved = resolveProvider({ mode, model: "gpt-4o-mini" });
      expect(resolved.egress).toBe("external");
      expect(resolved.endpoint).toBeNull();
    }
  });
});

describe("read-path boundary (extraction never fires on recall/search)", () => {
  // The zero-token recall guarantee depends on the read paths never reaching
  // the LLM extractor. Enforce it structurally: engine.ts (recall/search/
  // traverse/path/neighbors) must not import the extraction module.
  test("engine.ts does not import the conversation extractor", async () => {
    const engineSrc = await readFile(
      fileURLToPath(new URL("../src/engine.ts", import.meta.url)),
      "utf8",
    );
    expect(engineSrc).not.toContain("extract-conversation");
  });

  test("recall.ts does not import the conversation extractor", async () => {
    const recallSrc = await readFile(
      fileURLToPath(new URL("../src/recall.ts", import.meta.url)),
      "utf8",
    );
    expect(recallSrc).not.toContain("extract-conversation");
  });
});

describe("factsToGraph", () => {
  test("every materialized node is INFERRED, never EXTRACTED", () => {
    const { nodes } = factsToGraph(GOLDEN);
    expect(nodes).toHaveLength(2);
    for (const n of nodes) {
      expect(n.properties.confidence).toBe("INFERRED");
      expect(n.properties.source).toBe("conversation");
      expect(n.properties.hash).toBeTruthy();
    }
  });

  test("relations become label-keyed edges for the indexer to resolve", () => {
    const { edges } = factsToGraph(GOLDEN);
    expect(edges).toEqual([
      { fromLabel: "warm-pool-in-boot", toLabel: "cold-start-deploy-failure", label: "FIXES" },
    ]);
  });

  test("source is overridable for the explicit /memory:store path", () => {
    const { nodes } = factsToGraph([GOLDEN[0]], "manual");
    expect(nodes[0].properties.source).toBe("manual");
  });
});
