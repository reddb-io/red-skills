/**
 * ADR 0136 deletion ratchets: consolidation is only durable when a second
 * implementation makes the gate red. Each fixture below is executable-looking
 * code, not prose, and models the semantic seam that was deleted.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADR_0136_OWNERS,
  collectCustodyVerdictParkFindings,
  collectCustodyVerdictParkFindingsFromFiles,
  formatCustodyVerdictParkFailure,
  readCustodyVerdictParkFiles,
  type CustodyVerdictParkFile,
} from "../src/core/custody-verdict-park-guard.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

const OWNER_FILES: readonly CustodyVerdictParkFile[] = [
  {
    relativePath: ADR_0136_OWNERS["custody-requeuer"],
    sourceText: `
      const history = [...record.semanticBounces, failure];
      await deps.adoptBranch(ticket, branch);
      await deps.readyForAgent(ticket, evidence);
    `,
  },
  {
    relativePath: ADR_0136_OWNERS["blocker-parser"],
    sourceText: `
      const BLOCKER_OPEN = "<!-- red:blocker-state v1 -->";
      const fields = parseFields(inner);
      if (fields.status !== "blocked") return null;
    `,
  },
  {
    relativePath: ADR_0136_OWNERS["requeue-applier"],
    sourceText: `
      await deps.verifyBaseFreshness(input.body);
      await deps.releaseClaims(input.issue);
      await deps.editBody(input.issue, plan.body);
      await deps.editLabels(input.issue, remove, add);
    `,
  },
];

function duplicate(relativePath: string, sourceText: string): CustodyVerdictParkFile[] {
  return [...OWNER_FILES, { relativePath, sourceText }];
}

describe("ADR 0136 has one Custodian, one Verdict, and one Park", () => {
  it("is green on the live source tree", () => {
    const findings = collectCustodyVerdictParkFindings(ROOT);
    expect(findings, formatCustodyVerdictParkFailure(findings)).toEqual([]);
  });

  it("scans the live source tree and reaches every declared owner", () => {
    const files = readCustodyVerdictParkFiles(ROOT);
    const paths = files.map((file) => file.relativePath);

    expect(files.length).toBeGreaterThan(500);
    expect(paths).toEqual(expect.arrayContaining(Object.values(ADR_0136_OWNERS)));
  });
});

describe("the duplicate-implementation ratchets can go red", () => {
  it("fails on a second custody re-queuer", () => {
    const findings = collectCustodyVerdictParkFindingsFromFiles(
      duplicate("apps/plugin-dev/src/core/landing-retry.ts", `
        const history = [...custody.semanticBounces, failure];
        await ports.adoptBranch(owner, branch);
        await ports.readyForAgent(owner, { history });
      `),
    );

    expect(findings).toMatchObject([
      { rule: "custody-requeuer", kind: "duplicate", relativePath: "apps/plugin-dev/src/core/landing-retry.ts" },
    ]);
  });

  it("fails on a second blocker parser", () => {
    const findings = collectCustodyVerdictParkFindingsFromFiles(
      duplicate("packages/worker/src/engine/local-blocker.ts", `
        const match = /<!-- red:blocker-state v1 -->([\\s\\S]*?)<!-- \\/red:blocker-state -->/.exec(body);
        return match !== null && /^status:\\s*blocked\\s*$/m.test(match[1] ?? "");
      `),
    );

    expect(findings).toMatchObject([
      { rule: "blocker-parser", kind: "duplicate", relativePath: "packages/worker/src/engine/local-blocker.ts" },
    ]);
  });

  it("fails on a second requeue applier", () => {
    const findings = collectCustodyVerdictParkFindingsFromFiles(
      duplicate("apps/plugin-dev/src/commands/quick-requeue.ts", `
        await deps.verifyBaseFreshness(body);
        await deps.releaseClaims(issue);
        await deps.editBody(issue, nextBody);
        await deps.editLabels(issue, remove, add);
      `),
    );

    expect(findings).toMatchObject([
      { rule: "requeue-applier", kind: "duplicate", relativePath: "apps/plugin-dev/src/commands/quick-requeue.ts" },
    ]);
  });

  it("fails when the classification hook is reintroduced", () => {
    const findings = collectCustodyVerdictParkFindingsFromFiles([
      ...OWNER_FILES,
      {
        relativePath: "apps/plugin-dev/src/core/feedback-override.ts",
        sourceText: `hooks.on_feedback_classify = "classify-failure";`,
      },
    ]);

    expect(findings).toMatchObject([
      { rule: "classification-hook", kind: "forbidden", relativePath: "apps/plugin-dev/src/core/feedback-override.ts" },
    ]);
  });

  it("does not treat prose or canonical API callers as rival implementations", () => {
    const findings = collectCustodyVerdictParkFindingsFromFiles([
      ...OWNER_FILES,
      {
        relativePath: "apps/plugin-dev/src/core/caller.ts",
        sourceText: `
          // on_feedback_classify was removed; applyRequeue is the only door.
          import { applyRequeue } from "./requeue.js";
          export const run = () => applyRequeue(deps, input);
        `,
      },
    ]);

    expect(findings).toEqual([]);
  });
});

describe("the ADR 0136 ratchets run in every gate", () => {
  it("is declared as a repo invariant", () => {
    expect(REPO_INVARIANT_SUITES).toContainEqual(expect.objectContaining({
      name: "invariants:custody-verdict-park",
      scope: "apps/plugin-dev",
      script: "test:invariants",
    }));
  });
});
