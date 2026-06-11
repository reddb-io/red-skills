import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAfkHeadlessAutoLinkProvider,
  parseAutoLinkProviderResponse,
  type BrainAutoLinkProvider,
  type BrainAutoLinkRequest,
} from "../src/auto-linker.js";
import { BrainStore } from "../src/store.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brain-store-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("BrainStore hybrid search", () => {
  it("returns score breakdowns for lexical, tag, and kind matches", async () => {
    const root = await tempRoot();
    const store = await BrainStore.open({ uri: `file://${join(root, "brain.rdb")}` });
    try {
      const artifact = await store.capture({
        title: "OAuth rollout",
        kind: "decision",
        tags: ["auth"],
        content: "Use OAuth for browser sign-in.",
      });

      const hits = await store.search("auth decision oauth");

      expect(hits[0]).toEqual(expect.objectContaining({
        artifact: expect.objectContaining({ rid: artifact.rid }),
        score_breakdown: expect.objectContaining({
          lexical: expect.any(Number),
          tags: expect.any(Number),
          kind: expect.any(Number),
          connections: 0,
          vector: 0,
        }),
      }));
      expect(hits[0]?.score_breakdown.lexical).toBeGreaterThan(0);
      expect(hits[0]?.score_breakdown.tags).toBeGreaterThan(0);
      expect(hits[0]?.score_breakdown.kind).toBeGreaterThan(0);
      expect(hits[0]?.score).toBe(hits[0]?.score_breakdown.total);
    } finally {
      await store.close();
    }
  });

  it("boosts artifacts connected to matching artifacts", async () => {
    const root = await tempRoot();
    const store = await BrainStore.open({ uri: `file://${join(root, "brain.rdb")}` });
    try {
      const decision = await store.capture({
        title: "Use bearer auth",
        kind: "decision",
        content: "Authenticated requests should use bearer tokens.",
      });
      const mobileEvidence = await store.capture({
        title: "Mobile app login",
        kind: "fact",
        content: "The mobile app depends on the same authenticated request path.",
      });
      await store.link({
        from: mobileEvidence.rid,
        to: decision.rid,
        kind: "supports",
      });

      const hits = await store.search("mobile", 10);
      const decisionHit = hits.find((hit) => hit.artifact.rid === decision.rid);
      const evidenceHit = hits.find((hit) => hit.artifact.rid === mobileEvidence.rid);

      expect(evidenceHit?.score_breakdown.lexical).toBeGreaterThan(0);
      expect(decisionHit?.score_breakdown.lexical).toBe(0);
      expect(decisionHit?.score_breakdown.connections).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  });

  it("renders think answers with evidence scores and ranking signals", async () => {
    const root = await tempRoot();
    const store = await BrainStore.open({ uri: `file://${join(root, "brain.rdb")}` });
    try {
      await store.capture({
        title: "Use local Brain",
        kind: "decision",
        tags: ["brain"],
        content: "Keep Brain storage local by default.",
      });

      const result = await store.think("brain decision");

      expect(result.answer).toContain("score");
      expect(result.answer).toContain("lexical");
      expect(result.answer).toContain("tags");
      expect(result.answer).toContain("kind");
      expect(result.hits[0]?.score_breakdown.total).toBe(result.hits[0]?.score);
    } finally {
      await store.close();
    }
  });
});

describe("BrainStore autolinking", () => {
  it("derives and persists typed edges through an injected provider", async () => {
    const root = await tempRoot();
    const requests: BrainAutoLinkRequest[] = [];
    const provider: BrainAutoLinkProvider = {
      async deriveConnections(request) {
        requests.push(request);
        const target = request.candidates[0]?.artifact;
        if (!target) return [];
        return [{
          from: request.newArtifact.rid,
          to: target.rid,
          kind: "supports",
          reason: "The new artifact reinforces the earlier decision.",
        }];
      },
    };
    const uri = `file://${join(root, "brain.rdb")}`;
    const store = await BrainStore.open({ uri, autoLinker: provider, autoLinkErrors: "throw" });
    try {
      const decision = await store.capture({
        title: "Use bearer auth",
        kind: "decision",
        content: "The API should use bearer tokens for authenticated requests.",
      });
      const evidence = await store.capture({
        title: "Bearer token evidence",
        kind: "fact",
        content: "Production clients already send bearer tokens, supporting the bearer auth decision.",
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.newArtifact.rid).toBe(evidence.rid);
      expect(requests[0]?.candidates.map((candidate) => candidate.artifact.rid)).toContain(decision.rid);
      expect(requests[0]?.think.answer).toContain("Use bearer auth");

      const edges = await store.listConnections();
      expect(edges).toEqual([
        expect.objectContaining({
          kind: "supports",
          from_rid: evidence.rid,
          to_rid: decision.rid,
          properties: expect.objectContaining({
            confidence: "derived",
            reason: "The new artifact reinforces the earlier decision.",
            metadata: expect.objectContaining({
              derived_by: "brain.autolink.afk-headless",
              source_artifact_rid: evidence.rid,
            }),
          }),
        }),
      ]);
    } finally {
      await store.close();
    }

    const reopened = await BrainStore.open({ uri });
    try {
      expect((await reopened.listConnections()).map((edge) => edge.kind)).toEqual(["supports"]);
    } finally {
      await reopened.close();
    }
  });

  it("parses proposals from an AFK headless command adapter", async () => {
    const provider = createAfkHeadlessAutoLinkProvider({
      command: process.execPath,
      args: [
        "-e",
        [
          "let body='';",
          "process.stdin.on('data', c => body += c);",
          "process.stdin.on('end', () => {",
          " const req = JSON.parse(body);",
          " process.stdout.write(JSON.stringify({ connections: [{",
          "   from: req.newArtifact.rid,",
          "   to: req.candidates[0].artifact.rid,",
          "   kind: 'related_to',",
          "   reason: 'headless command derived this edge'",
          " }] }));",
          "});",
        ].join(""),
      ],
      timeoutMs: 5_000,
    });

    await expect(provider.deriveConnections({
      newArtifact: { rid: 2, id: "two", title: "Two", kind: "fact", content: "two", tags: [] },
      candidates: [{
        artifact: { rid: 1, id: "one", title: "One", kind: "fact", content: "one", tags: [] },
        score: 1,
        excerpt: "one",
      }],
      think: { query: "two", answer: "One" },
      allowedKinds: ["supports", "contradicts", "related_to"],
    })).resolves.toEqual([{
      from: 2,
      to: 1,
      kind: "related_to",
      reason: "headless command derived this edge",
      metadata: undefined,
    }]);
  });

  it("accepts fenced JSON from headless agent output", () => {
    expect(parseAutoLinkProviderResponse("```json\n[{\"from\":2,\"to\":1,\"kind\":\"contradicts\"}]\n```")).toEqual([
      { from: 2, to: 1, kind: "contradicts", reason: undefined, metadata: undefined },
    ]);
  });
});

describe("BrainStore event KPIs", () => {
  it("computes a daily KPI series over captured kind:event artifacts", async () => {
    const root = await tempRoot();
    const store = await BrainStore.open({ uri: `file://${join(root, "brain.rdb")}` });
    try {
      await store.capture({
        title: "slack message one",
        content: "release train is green",
        kind: "event",
        tags: ["channel-event"],
        metadata: { timestamp: "2026-06-01T08:00:00.000Z", platform: "slack", event_type: "message" },
      });
      await store.capture({
        title: "slack message two",
        content: "deploy started",
        kind: "event",
        tags: ["channel-event"],
        metadata: { timestamp: "2026-06-01T20:00:00.000Z", platform: "slack", event_type: "message" },
      });
      await store.capture({
        title: "discord message one",
        content: "ops alert",
        kind: "event",
        tags: ["channel-event"],
        metadata: { timestamp: "2026-06-03T09:00:00.000Z", platform: "discord", event_type: "message" },
      });
      // A non-event artifact must not be counted.
      await store.capture({ title: "Use bearer auth", content: "decision body", kind: "decision" });

      const result = await store.eventKpis({ interval: "day", groupBy: "platform" });

      expect(result.kind).toBe("event");
      expect(result.total).toBe(3);
      const overall = result.series.find((s) => s.group === null);
      expect(overall?.buckets.map((b) => ({ iso: b.startIso, count: b.count }))).toEqual([
        { iso: "2026-06-01T00:00:00.000Z", count: 2 },
        { iso: "2026-06-02T00:00:00.000Z", count: 0 },
        { iso: "2026-06-03T00:00:00.000Z", count: 1 },
      ]);
      expect(result.series.map((s) => ({ group: s.group, total: s.total }))).toEqual([
        { group: null, total: 3 },
        { group: "slack", total: 2 },
        { group: "discord", total: 1 },
      ]);
    } finally {
      await store.close();
    }
  });
});
