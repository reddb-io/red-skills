// The drain-end Attention audit (Spec #4164, Ticket #4171).
//
// Every assertion here runs offline: the assembly is a pure function over fixed
// Decision-trail fixtures, and the identity rule is a pure function over config
// values. **No test in this file makes a model call**, which is the point — the
// judgment step is a declared seam, and everything a diff can decide is decided
// without it.

import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  assembleAttentionAudit,
  isEvidencePointer,
  renderAttentionSection,
  type AttentionAuditInput,
  type AttentionDrainOutcome,
  type AttentionTrailRow,
} from "../src/core/attention-audit.js";
import {
  attentionAuditIdentityRefusal,
  judgeModelFamily,
  resolveAttentionAuditIdentity,
  resolveDrainWorkerIdentity,
  ATTENTION_AUDIT_RUNNER_PREFERENCE,
  ATTENTION_AUDIT_TIER,
  DRAIN_WORKER_TIER,
} from "../src/core/attention-audit-identity.js";
import { CONFIG_DEFAULTS, type ConfigValues } from "../src/core/config.js";
import {
  buildActivityReviewReport,
  renderActivityReviewReport,
  renderActivityReviewReportToon,
  type ActivityReviewInput,
} from "../src/core/activity-review.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const GENERATED_AT = "2026-08-19T11:59:00.000Z";

/** The identity the shipped config pins, spelled once so the fixtures agree. */
const CODEX_IDENTITY = { runner: "codex", model: "gpt-5.6-sol", family: "openai" } as const;

function row(overrides: Partial<AttentionTrailRow> = {}): AttentionTrailRow {
  return {
    worker: "w-1",
    issue: 4171,
    at: "2026-08-19T02:00:00.000Z",
    type: "fork",
    decision: "Kept the assembly pure and injected the judge",
    why: "the model call is the only step a diff cannot decide",
    evidence: "https://github.com/reddb-io/red-skills/pull/4199",
    result: "assembly landed",
    ...overrides,
  };
}

function outcome(overrides: Partial<AttentionDrainOutcome> = {}): AttentionDrainOutcome {
  return { issue: 4171, state: "landed", reentries: 0, ...overrides };
}

function auditInput(overrides: Partial<AttentionAuditInput> = {}): AttentionAuditInput {
  return {
    drain: "drain-2026-08-19",
    generatedAt: GENERATED_AT,
    identity: CODEX_IDENTITY,
    rows: [],
    outcomes: [],
    ...overrides,
  };
}

function defaultConfig(): ConfigValues {
  return { ...CONFIG_DEFAULTS };
}

describe("isEvidencePointer — a pointer is one token a reader can open", () => {
  it("accepts URLs, SHAs, issue refs and paths", () => {
    expect(isEvidencePointer("https://github.com/reddb-io/red-skills/pull/4199")).toBe(true);
    expect(isEvidencePointer("03b4cf7673914ddbed9b08f93e7b81f167550e90")).toBe(true);
    expect(isEvidencePointer("#4167")).toBe(true);
    expect(isEvidencePointer("reddb-io/red-skills#4167")).toBe(true);
    expect(isEvidencePointer("apps/plugin-dev/src/core/attention-audit.ts")).toBe(true);
    expect(isEvidencePointer("apps/plugin-dev/src/core/attention-audit.ts:42")).toBe(true);
  });

  it("refuses prose, however confident — a claim citing itself is not evidence", () => {
    expect(isEvidencePointer("the tests passed locally")).toBe(false);
    expect(isEvidencePointer("verified by inspection")).toBe(false);
    expect(isEvidencePointer("")).toBe(false);
    expect(isEvidencePointer("   ")).toBe(false);
  });
});

describe("assembleAttentionAudit — the three findings a diff can decide", () => {
  it("flags a decision row whose evidence is prose rather than a pointer", () => {
    const audit = assembleAttentionAudit(
      auditInput({
        rows: [row({ evidence: "checked it by hand, looked right" })],
        outcomes: [outcome()],
      }),
    );

    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0]).toMatchObject({
      kind: "weak-evidence",
      worker: "w-1",
      issue: 4171,
      evidence: "checked it by hand, looked right",
    });
  });

  it("flags a verified unit the drain never landed, naming the outcome that disagrees", () => {
    const audit = assembleAttentionAudit(
      auditInput({
        rows: [row({ type: "verified-unit", result: "gate green", evidence: "#4171" })],
        outcomes: [outcome({ state: "parked" })],
      }),
    );

    expect(audit.findings.map((finding) => finding.kind)).toEqual(["unproven-claim"]);
    expect(audit.findings[0]?.detail).toContain("outcome parked");
  });

  it("flags a verified unit for an issue with no outcome recorded at all", () => {
    const audit = assembleAttentionAudit(
      auditInput({ rows: [row({ type: "verified-unit", evidence: "#4171" })], outcomes: [] }),
    );

    expect(audit.findings.map((finding) => finding.kind)).toEqual(["unproven-claim"]);
    expect(audit.findings[0]?.detail).toContain("no outcome recorded");
  });

  it("flags re-entries the trail never explains, and stops flagging once it does", () => {
    const unlogged = assembleAttentionAudit(
      auditInput({ rows: [row()], outcomes: [outcome({ reentries: 2 })] }),
    );
    expect(unlogged.findings.map((finding) => finding.kind)).toEqual(["unlogged-pivot"]);
    expect(unlogged.findings[0]?.detail).toBe("2 re-entries against 0 logged pivot/revert rows");

    const logged = assembleAttentionAudit(
      auditInput({
        rows: [
          row({ type: "pivot", evidence: "#4171" }),
          row({ type: "revert", evidence: "#4171" }),
        ],
        outcomes: [outcome({ reentries: 2 })],
      }),
    );
    expect(logged.findings).toEqual([]);
  });

  it("finds nothing in a clean trail, and reads the row count back", () => {
    const audit = assembleAttentionAudit(
      auditInput({
        rows: [row(), row({ type: "verified-unit", worker: "w-2" })],
        outcomes: [outcome()],
      }),
    );

    expect(audit.findings).toEqual([]);
    expect(audit.rows_read).toBe(2);
    expect(audit.warnings).toEqual([]);
    expect(audit.identity).toBe("codex/gpt-5.6-sol (openai)");
    expect(audit.judgment).toEqual([]);
  });

  it("assembles an EMPTY-trail drain into a real audit that names the silence", () => {
    const audit = assembleAttentionAudit(auditInput());

    expect(audit.rows_read).toBe(0);
    expect(audit.findings).toEqual([]);
    expect(audit.warnings).toEqual([
      "drain logged no decision rows — the trail cannot be audited",
    ]);
    expect(audit.schema_version).toBe("red.dev.attention_audit.v1");
    expect(audit.drain).toBe("drain-2026-08-19");
  });

  it("says out loud when no cross-family identity could be pinned", () => {
    const audit = assembleAttentionAudit(auditInput({ identity: null, rows: [row()] }));

    expect(audit.identity).toBe("unpinned");
    expect(audit.warnings).toContain(
      "no audit identity on a different model family than the drain's Workers",
    );
  });

  it("carries judgment notes through without inventing any", () => {
    const audit = assembleAttentionAudit(
      auditInput({
        rows: [row()],
        judgment: [{ identity: "codex/gpt-5.6-sol", note: "the fork rationale is thin" }],
      }),
    );

    expect(audit.judgment).toEqual([
      { identity: "codex/gpt-5.6-sol", note: "the fork rationale is thin" },
    ]);
  });
});

describe("renderAttentionSection — grouped, and never silently absent", () => {
  it("groups findings under their kind and prints the auditing identity", () => {
    const audit = assembleAttentionAudit(
      auditInput({
        rows: [
          row({ evidence: "looked fine to me" }),
          row({ type: "verified-unit", worker: "w-2", evidence: "#4171" }),
        ],
        outcomes: [outcome({ state: "abandoned", reentries: 3 })],
      }),
    );
    const rendered = renderAttentionSection(audit).join("\n");

    expect(rendered).toContain("Attention — drain-2026-08-19");
    expect(rendered).toContain("audited by: codex/gpt-5.6-sol (openai)");
    expect(rendered).toContain("weak evidence (1)");
    expect(rendered).toContain("unproven claims (1)");
    expect(rendered).toContain("unlogged pivots (1)");
  });

  it("states its own emptiness rather than vanishing", () => {
    expect(renderAttentionSection(null).join("\n")).toContain(
      "(no drain-end audit for this window)",
    );
    expect(renderAttentionSection(assembleAttentionAudit(auditInput())).join("\n")).toContain(
      "(nothing flagged across 0 decision rows)",
    );
  });
});

describe("daily_review — the morning read starts from Attention", () => {
  function reviewInput(audit: AttentionAuditInput | null): ActivityReviewInput {
    return {
      kind: "daily",
      now: NOW,
      issues: [],
      pullRequests: [],
      gitStats: { commits: 0, added: 0, removed: 0 },
      history: [],
      activeWorkers: [],
      tokenSummary: { available: true, total: 10, input: 6, output: 4, sourceRecords: 1 },
      attentionAudit: audit === null ? null : assembleAttentionAudit(audit),
    };
  }

  /** A completed drain: one Worker, one landed issue, one prose cite it should not have got away with. */
  const COMPLETED = auditInput({
    rows: [
      row({ evidence: "ran it, seemed fine" }),
      row({ type: "verified-unit", worker: "w-2", evidence: "#4171" }),
    ],
    outcomes: [outcome({ state: "parked", reentries: 1 })],
  });

  it("contains the Attention section for a completed fixture drain", () => {
    const report = buildActivityReviewReport(reviewInput(COMPLETED));
    const rendered = renderActivityReviewReport(report);

    expect(report.attention?.drain).toBe("drain-2026-08-19");
    expect(rendered).toContain("Attention — drain-2026-08-19");
    expect(rendered).toContain("weak evidence (1)");
    expect(rendered).toContain("unproven claims (1)");
  });

  it("prints Attention BEFORE the big numbers, so the numbers do not frame the audit", () => {
    const rendered = renderActivityReviewReport(buildActivityReviewReport(reviewInput(COMPLETED)));

    expect(rendered.indexOf("Attention —")).toBeLessThan(rendered.indexOf("Big numbers"));
  });

  it("carries the audit through the TOON render the agent surface returns", () => {
    const decoded = decode(
      renderActivityReviewReportToon(buildActivityReviewReport(reviewInput(COMPLETED))),
    ) as { attention: { drain: string; rows_read: number } };

    expect(decoded.attention.drain).toBe("drain-2026-08-19");
    expect(decoded.attention.rows_read).toBe(2);
  });

  it("keeps the section present, and honest, when no drain ended in the window", () => {
    const report = buildActivityReviewReport(reviewInput(null));

    expect(report.attention).toBeNull();
    expect(renderActivityReviewReport(report)).toContain("(no drain-end audit for this window)");
  });
});

describe("the audit identity is pinned to a different model family than the drain's Workers", () => {
  it("places a configured model id in a coarse family, and refuses to guess", () => {
    expect(judgeModelFamily("claude-opus-5")).toBe("anthropic");
    expect(judgeModelFamily("openrouter/anthropic/claude-sonnet-5")).toBe("anthropic");
    expect(judgeModelFamily("gpt-5.6-sol")).toBe("openai");
    expect(judgeModelFamily("MiniMax-M3")).toBe("minimax");
    expect(judgeModelFamily("gemini-3-pro")).toBe("google");
    expect(judgeModelFamily("some-local-thing")).toBe("unknown");
  });

  it("pins a cross-family identity on the SHIPPED configuration", () => {
    const values = defaultConfig();
    const drain = resolveDrainWorkerIdentity(values);
    const audit = resolveAttentionAuditIdentity(values);

    expect(drain).toMatchObject({ runner: "claude", family: "anthropic" });
    expect(audit).toMatchObject({ runner: "codex", family: "openai" });
    expect(audit?.family).not.toBe(drain.family);
    expect(attentionAuditIdentityRefusal(values)).toBeNull();
  });

  it("moves the audit to the other side when the operator repoints the drain", () => {
    const values = { ...defaultConfig(), "afk.default_runner": "codex" };

    expect(resolveDrainWorkerIdentity(values)).toMatchObject({ runner: "codex", family: "openai" });
    expect(resolveAttentionAuditIdentity(values)).toMatchObject({
      runner: "claude",
      family: "anthropic",
    });
    expect(attentionAuditIdentityRefusal(values)).toBeNull();
  });

  it("refuses to pin an identity when every runner sits on one family", () => {
    const values = defaultConfig();
    for (const runner of ATTENTION_AUDIT_RUNNER_PREFERENCE) {
      values[`afk.models.${runner}.${ATTENTION_AUDIT_TIER}.model`] = "claude-opus-5";
      values[`afk.models.${runner}.${DRAIN_WORKER_TIER}.model`] = "claude-opus-5";
    }

    expect(resolveAttentionAuditIdentity(values)).toBeNull();
    expect(attentionAuditIdentityRefusal(values)).toContain(
      "the drain's own mind",
    );
  });

  it("refuses when the drain's own model family cannot be recognised", () => {
    const values = defaultConfig();
    values[`afk.models.claude.${DRAIN_WORKER_TIER}.model`] = "some-local-thing";

    expect(resolveAttentionAuditIdentity(values)).toBeNull();
    expect(attentionAuditIdentityRefusal(values)).toContain("unrecognised");
  });

  it("judges at the validate tier and compares against the complex tier the Workers code at", () => {
    expect(ATTENTION_AUDIT_TIER).toBe("validate");
    expect(DRAIN_WORKER_TIER).toBe("complex");
    expect(ATTENTION_AUDIT_RUNNER_PREFERENCE).toContain("codex");
    expect(ATTENTION_AUDIT_RUNNER_PREFERENCE).toContain("claude");
  });
});
