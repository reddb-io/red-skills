import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  REDACTABLE_FIELDS,
  buildFederationReport,
  denyAllRedactPolicy,
  loadFederationConfig,
  parseFederationYaml,
  type FederationTelemetryEvent,
} from "../src/federation.js";

const cleanup: string[] = [];

async function makeRoot(repoName: string, notes: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `memory-federation-${repoName}-`));
  cleanup.push(dir);
  const notesDir = join(dir, ".red/memory/notes");
  await mkdir(notesDir, { recursive: true });
  const configDir = join(dir, ".red/memory");
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      version: 1,
      mode: "markdown-only",
      notesDir: ".red/memory/notes",
      hooks: { sessionStart: false, postToolUse: false, stop: false, preCompact: false },
      mcp: false,
      reddb: false,
    }),
  );
  for (const [name, body] of Object.entries(notes)) {
    await writeFile(join(notesDir, name), body);
  }
  return dir;
}

async function makeHostRoot(
  roots: { repo: string; path: string }[],
  extra: string[] = [],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-federation-host-"));
  cleanup.push(dir);
  await mkdir(join(dir, ".red/memory"), { recursive: true });
  const yaml = [
    "roots:",
    ...roots.flatMap((r) => [`  - repo: ${r.repo}`, `    path: ${r.path}`]),
    ...extra,
  ].join("\n");
  await writeFile(join(dir, ".red/memory/federation.yaml"), `${yaml}\n`);
  return dir;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("federation cross-root read", () => {
  test("parseFederationYaml reads the documented roots: list format", () => {
    const cfg = parseFederationYaml(
      `# top-level comment\nroots:\n  - repo: alpha\n    path: ./alpha # inline\n  - repo: beta\n    path: "/abs/beta"\n`,
    );
    expect(cfg.roots).toEqual([
      { repo: "alpha", path: "./alpha" },
      { repo: "beta", path: "/abs/beta" },
    ]);
    expect(cfg.redact).toEqual({ fields: [], scopes: [] });
    expect(cfg.trust).toEqual({});
  });

  test("missing federation.yaml returns null (graceful)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-federation-empty-"));
    cleanup.push(dir);
    expect(await loadFederationConfig(dir)).toBeNull();
  });

  test("buildFederationReport returns empty report when config is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-federation-empty-"));
    cleanup.push(dir);
    const report = await buildFederationReport(dir, "anything", {
      now: 1_700_000_000_000,
    });
    expect(report).toMatchObject({
      schema_version: "memory.federation.v1",
      read_only: true,
      query: "anything",
      roots_queried: 0,
      results: [],
      roots: [],
    });
    expect(report.generated_at).toBe(new Date(1_700_000_000_000).toISOString());
  });

  test("merges hits across two roots and tags each with origin_repo", async () => {
    const alpha = await makeRoot("alpha", {
      "ingest.md": "# ingest\n\nA short note about ingest only.",
      "vector.md": "# vector\n\nNothing about pipelines here.",
    });
    const beta = await makeRoot("beta", {
      "pipeline.md":
        "# pipeline notes\n\nThe ingest pipeline pipeline pipeline ingest is central.",
    });
    const host = await makeHostRoot([
      { repo: "alpha", path: alpha },
      { repo: "beta", path: beta },
    ]);

    const report = await buildFederationReport(host, "ingest pipeline");

    expect(report.schema_version).toBe("memory.federation.v1");
    expect(report.roots_queried).toBe(2);
    expect(report.roots.map((r) => r.origin_repo).sort()).toEqual(["alpha", "beta"]);
    expect(report.results.length).toBeGreaterThanOrEqual(2);
    for (const result of report.results) {
      expect(result.origin_repo).toMatch(/^(alpha|beta)$/);
      expect(typeof result.id).toBe("string");
      expect(typeof result.score).toBe("number");
      expect(result.score).toBeGreaterThan(0);
    }
    const repos = new Set(report.results.map((r) => r.origin_repo));
    expect(repos.has("alpha")).toBe(true);
    expect(repos.has("beta")).toBe(true);
    expect(report.results[0]?.origin_repo).toBe("beta");
  });

  test("parses redact + trust blocks", () => {
    const cfg = parseFederationYaml(
      [
        "roots:",
        "  - repo: alpha",
        "    path: ./alpha",
        "  - repo: beta",
        "    path: ./beta",
        "redact:",
        "  fields:",
        "    - excerpt",
        "    - path",
        "  scopes:",
        "    - beta",
        "trust:",
        "  alpha: 0.9",
        "  beta: 0.2",
      ].join("\n"),
    );
    expect(cfg.redact).toEqual({ fields: ["excerpt", "path"], scopes: ["beta"] });
    expect(cfg.trust).toEqual({ alpha: 0.9, beta: 0.2 });
  });

  test("redact policy is honored — masked fields never leak through the surface", async () => {
    const alpha = await makeRoot("alpha", {
      "ingest.md": "# ingest\n\nA short note about ingest only.",
    });
    const host = await makeHostRoot([{ repo: "alpha", path: alpha }], [
      "redact:",
      "  fields:",
      "    - excerpt",
      "    - path",
    ]);

    const report = await buildFederationReport(host, "ingest");
    expect(report.policy.fields).toEqual(["excerpt", "path"]);
    expect(report.policy.default_deny).toBe(false);
    expect(report.results.length).toBeGreaterThan(0);
    for (const result of report.results) {
      expect(result.excerpt).toBeNull();
      expect(result.path).toBeNull();
      expect(result.redacted_fields).toEqual(["excerpt", "path"]);
      expect(typeof result.confidence_local).toBe("number");
      expect(typeof result.confidence_remote).toBe("number");
      expect(result.confidence_local).toBeGreaterThan(0);
    }
  });

  test("redact.scopes drops the entire origin before merge", async () => {
    const alpha = await makeRoot("alpha", {
      "ingest.md": "# ingest\n\nAlpha ingest note.",
    });
    const beta = await makeRoot("beta", {
      "ingest.md": "# ingest\n\nBeta ingest note.",
    });
    const host = await makeHostRoot(
      [
        { repo: "alpha", path: alpha },
        { repo: "beta", path: beta },
      ],
      ["redact:", "  scopes:", "    - beta"],
    );

    const report = await buildFederationReport(host, "ingest");
    const repos = new Set(report.results.map((r) => r.origin_repo));
    expect(repos.has("beta")).toBe(false);
    const betaStatus = report.roots.find((r) => r.origin_repo === "beta");
    expect(betaStatus?.status).toBe("dropped-by-policy");
    expect(betaStatus?.hits).toBe(0);
  });

  test("malformed redact block degrades to default-deny — nothing leaks", async () => {
    const alpha = await makeRoot("alpha", {
      "ingest.md": "# ingest\n\nA short note about ingest.",
    });
    const host = await makeHostRoot([{ repo: "alpha", path: alpha }], [
      "redact:",
      "  fields: not-a-list",
      "  this is malformed",
    ]);

    const report = await buildFederationReport(host, "ingest");
    expect(report.policy.default_deny).toBe(true);
    // Default-deny drops every configured origin AND masks every documented field.
    expect(new Set(report.policy.fields)).toEqual(new Set(REDACTABLE_FIELDS));
    expect(report.policy.scopes).toContain("alpha");
    expect(report.results).toEqual([]);
    const alphaStatus = report.roots.find((r) => r.origin_repo === "alpha");
    expect(alphaStatus?.status).toBe("dropped-by-policy");
  });

  test("denyAllRedactPolicy mirrors documented redactable fields", () => {
    const policy = denyAllRedactPolicy([{ repo: "alpha", path: "/x" }]);
    expect(policy.defaultDeny).toBe(true);
    expect(new Set(policy.fields)).toEqual(new Set(REDACTABLE_FIELDS));
    expect(policy.scopes).toEqual(["alpha"]);
  });

  test("confidence_remote comes from trust block; default 0.5", async () => {
    const alpha = await makeRoot("alpha", {
      "ingest.md": "# ingest\n\nIngest note from alpha.",
    });
    const beta = await makeRoot("beta", {
      "ingest.md": "# ingest\n\nIngest note from beta.",
    });
    const host = await makeHostRoot(
      [
        { repo: "alpha", path: alpha },
        { repo: "beta", path: beta },
      ],
      ["trust:", "  alpha: 0.9"],
    );

    const report = await buildFederationReport(host, "ingest");
    const alphaResult = report.results.find((r) => r.origin_repo === "alpha");
    const betaResult = report.results.find((r) => r.origin_repo === "beta");
    expect(alphaResult?.confidence_remote).toBe(0.9);
    expect(betaResult?.confidence_remote).toBe(0.5);
  });

  test("emits memory.federation.read telemetry once per query", async () => {
    const alpha = await makeRoot("alpha", {
      "ingest.md": "# ingest\n\nIngest note alpha.",
    });
    const host = await makeHostRoot([{ repo: "alpha", path: alpha }]);

    const events: FederationTelemetryEvent[] = [];
    await buildFederationReport(host, "ingest", {
      onTelemetry: (event) => {
        events.push(event);
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "memory.federation.read",
      query: "ingest",
      roots_queried: 1,
      results_count: 1,
      default_deny: false,
    });
  });

  test("reports missing-config status when a root has no memory config", async () => {
    const ghostDir = await mkdtemp(join(tmpdir(), "memory-federation-ghost-"));
    cleanup.push(ghostDir);
    const host = await makeHostRoot([{ repo: "ghost", path: ghostDir }]);

    const report = await buildFederationReport(host, "anything");
    expect(report.roots).toEqual([
      expect.objectContaining({ origin_repo: "ghost", status: "missing-config", hits: 0 }),
    ]);
    expect(report.results).toEqual([]);
  });
});
