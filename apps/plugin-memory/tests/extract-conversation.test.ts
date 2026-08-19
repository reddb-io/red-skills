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
    expect(a.system).toContain("Do not extract Odysseus-style Personal facts");
    expect(a.system).toContain("belong in Brain, not Memory");
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

  test("keeps an out-of-vocab kind (strict-write resolves, never rejects) but drops structural malformation", () => {
    const raw = JSON.stringify({
      facts: [
        { label: "ok", node_type: "concept", title: "Valid" },
        { label: "bad-type", node_type: "not-a-type", title: "Out-of-vocab kind" },
        { node_type: "concept", title: "missing label" },
      ],
    });
    const facts = parseExtraction(raw);
    // ADR 0035: an out-of-vocab classification is admitted at parse (its proposed
    // kind round-trips on `node_type`); only structural malformation (the missing
    // label) is dropped.
    expect(facts.map((f) => f.label)).toEqual(["ok", "bad-type"]);
    expect(facts.find((f) => f.label === "bad-type")?.node_type).toBe("not-a-type");

    // …and downstream, `factsToGraph` lands it on the base structural type while
    // preserving the proposed kind as an indexed engineering code — not rejected,
    // not flattened-with-loss, not a NodeType-violating string on `node_type`.
    const { nodes } = factsToGraph(facts);
    const resolved = nodes.find((n) => n.label === "bad-type")!;
    expect(resolved.node_type).toBe("concept");
    expect(resolved.properties.structural_type).toBe("concept");
    expect(resolved.properties.engineering_code).toBe("not-a-type");
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

  test("bedrock derives the regional runtime endpoint and carries the region", () => {
    const resolved = resolveProvider({
      mode: "bedrock",
      model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      region: "us-east-1",
    });
    expect(resolved.mode).toBe("bedrock");
    expect(resolved.endpoint).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    expect(resolved.region).toBe("us-east-1");
    // Bedrock is your AWS account/region, not loopback — it leaves the box.
    expect(resolved.egress).toBe("external");
  });

  test("bedrock honours an explicit baseUrl (VPC/PrivateLink or local proxy)", () => {
    const resolved = resolveProvider({
      mode: "bedrock",
      model: "anthropic.claude-3-haiku-20240307-v1:0",
      region: "eu-west-1",
      baseUrl: "http://localhost:4566",
    });
    // An on-box endpoint (e.g. a LocalStack/proxy) keeps inference local.
    expect(resolved.endpoint).toBe("http://localhost:4566");
    expect(resolved.egress).toBe("local");
    expect(resolved.region).toBe("eu-west-1");
  });

  test("bedrock without a region or baseUrl is a config error", () => {
    expect(() =>
      resolveProvider({ mode: "bedrock", model: "anthropic.claude-3-haiku-20240307-v1:0" }),
    ).toThrow(/region/);
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
      expect(n.properties.provenance_tier).toBe("proxy");
      expect(n.properties.source).toBe("conversation");
      expect(n.properties.hash).toBeTruthy();
    }
  });

  test("relations become label-keyed edges for the indexer to resolve", () => {
    const { edges } = factsToGraph(GOLDEN);
    expect(edges).toEqual([
      {
        fromLabel: "warm-pool-in-boot",
        toLabel: "cold-start-deploy-failure",
        label: "FIXES",
        properties: {
          confidence: "INFERRED",
          confidence_band: "medium",
          source: "conversation",
        },
      },
    ]);
  });

  test("source is overridable for the explicit /memory:store path", () => {
    const { nodes } = factsToGraph([GOLDEN[0]], "manual");
    expect(nodes[0].properties.source).toBe("manual");
  });

  test("an in-vocabulary structural kind maps to itself on both axes", () => {
    const [node] = factsToGraph([
      { label: "issue-302", node_type: "issue", title: "Strict-write gate", relations: [] },
    ]).nodes;
    expect(node.node_type).toBe("issue");
    expect(node.properties.structural_type).toBe("issue");
    // No separate classification for a structural kind: the code mirrors the kind
    // so the axis is still populated and queryable.
    expect(node.properties.engineering_code).toBe("issue");
  });

  test("a valid-but-non-structural kind keeps node_type but lands on the base structural axis", () => {
    // `decision` is a legal NodeType but a semantic classification, not a
    // structural type — so it stays on `node_type` (backward compat) while the
    // structural axis resolves to the base home and the code carries the kind.
    const [node] = factsToGraph([
      { label: "deploy-tuesdays", node_type: "decision", title: "Deploy on Tuesdays", relations: [] },
    ]).nodes;
    expect(node.node_type).toBe("decision");
    expect(node.properties.structural_type).toBe("concept");
    expect(node.properties.engineering_code).toBe("decision");
  });

  test("an out-of-vocab kind never writes an invalid NodeType, and preserves the classification", () => {
    const [node] = factsToGraph([
      { label: "p95-latency", node_type: "Benchmark Result", title: "p95 under load", relations: [] },
    ]).nodes;
    // node_type must stay a legal NodeType — falls back to the structural home.
    expect(node.node_type).toBe("concept");
    expect(node.properties.structural_type).toBe("concept");
    // The proposed kind is preserved as a normalized engineering code, not lost.
    expect(node.properties.engineering_code).toBe("benchmark-result");
  });
});
