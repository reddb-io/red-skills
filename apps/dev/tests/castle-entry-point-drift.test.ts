import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const devSourceRoot = resolve(here, "../src");

/**
 * ADR 0102 leaves these path families in dev because they adapt a host to the
 * castle; they do not own Worker, Ticket, Lane, or PR decisions.
 */
const HOST_ADAPTER_PATH_EXEMPTIONS = [
  "cli.ts",
  "**/*statusline*.ts",
  "**/*hook*.ts",
  "**/*skill*.ts",
  "**/*monitor-agent*.ts",
  "commands/inject-development-workflow.ts",
  "core/development-workflow.ts",
] as const;

const ENGINE_VERB_PATHS = {
  "gate-executor": [
    "core/backpressure.ts",
    "core/feedback.ts",
    "core/shared-gate.ts",
    "core/trust-gate.ts",
    "core/process-issue/lifecycle.ts",
  ],
  landing: [
    "core/landing.ts",
    "core/merge.ts",
    "core/process-issue/terminal.ts",
    "commands/run/reconcile.ts",
  ],
  config: ["core/config.ts"],
  "worker-drain": ["commands/run/command.ts", "core/session.ts"],
} as const;

type EngineEntity = "Worker" | "Ticket" | "Lane" | "PR";
type EngineVerb = keyof typeof ENGINE_VERB_PATHS;

interface DriftFinding {
  path: string;
  line: number;
  entities: EngineEntity[];
  verb?: EngineVerb;
}

const ENTITY_TOKENS: Record<EngineEntity, ReadonlySet<string>> = {
  Worker: new Set(["worker", "workers", "supervisor", "supervisors", "fleet"]),
  Ticket: new Set(["ticket", "tickets", "issue", "issues", "candidate", "candidates"]),
  Lane: new Set(["lane", "lanes", "queue", "queues", "claim", "claims", "lease", "leases"]),
  PR: new Set([
    "pr",
    "prs",
    "pullrequest",
    "branch",
    "branches",
    "diff",
    "feedback",
    "gate",
    "landing",
    "merge",
    "review",
    "validation",
  ]),
};

function sourceFilesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(path);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

function matchesPathPattern(path: string, pattern: string): boolean {
  if (!pattern.startsWith("**/")) return path === pattern;
  const basenamePattern = pattern.slice(3).replaceAll(".", "\\.").replaceAll("*", ".*");
  return new RegExp(`(?:^|/)${basenamePattern}$`).test(path);
}

function isHostAdapterPath(path: string): boolean {
  return HOST_ADAPTER_PATH_EXEMPTIONS.some((pattern) => matchesPathPattern(path, pattern));
}

function engineVerbFor(path: string): EngineVerb | undefined {
  return (Object.entries(ENGINE_VERB_PATHS) as Array<[EngineVerb, readonly string[]]>).find(
    ([, paths]) => paths.includes(path),
  )?.[0];
}

function controllingNodes(node: ts.Node): readonly ts.Node[] {
  if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    return [node.expression];
  }
  if (ts.isConditionalExpression(node)) return [node.condition];
  if (ts.isSwitchStatement(node)) return [node.expression];
  if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    return [node.initializer, node.expression];
  }
  if (ts.isForStatement(node)) {
    const controls: ts.Node[] = [];
    if (node.initializer) controls.push(node.initializer);
    if (node.condition) controls.push(node.condition);
    if (node.incrementor) controls.push(node.incrementor);
    return controls;
  }
  return [];
}

function tokensIn(node: ts.Node): Set<string> {
  const tokens = new Set<string>();
  const collect = (child: ts.Node): void => {
    if (ts.isIdentifier(child) || ts.isStringLiteralLike(child)) {
      const words = child.getText().replaceAll(/["']/g, "").split(/[^a-zA-Z0-9]+|(?=[A-Z])/);
      for (const word of words) {
        if (word !== "") tokens.add(word.toLowerCase());
      }
    }
    ts.forEachChild(child, collect);
  };
  collect(node);
  return tokens;
}

function entitiesIn(nodes: readonly ts.Node[]): EngineEntity[] {
  const tokens = new Set(nodes.flatMap((node) => [...tokensIn(node)]));
  return (Object.entries(ENTITY_TOKENS) as Array<[EngineEntity, ReadonlySet<string>]>).flatMap(
    ([entity, entityTokens]) => [...tokens].some((token) => entityTokens.has(token)) ? [entity] : [],
  );
}

function inspectSource(path: string, source: string): DriftFinding[] {
  if (isHostAdapterPath(path)) return [];
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const entities = new Set<EngineEntity>();
  let firstLine: number | undefined;
  const visit = (node: ts.Node): void => {
    const controls = controllingNodes(node);
    const controlledEntities = entitiesIn(controls);
    if (controlledEntities.length > 0) {
      firstLine ??= sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      for (const entity of controlledEntities) entities.add(entity);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (firstLine === undefined) return [];
  const verb = engineVerbFor(path);
  return [{ path, line: firstLine, entities: [...entities], ...(verb ? { verb } : {}) }];
}

let currentTreeFindingCache: DriftFinding[] | undefined;

function currentTreeFindings(): DriftFinding[] {
  currentTreeFindingCache ??= sourceFilesUnder(devSourceRoot).flatMap((absolutePath) => {
    const path = relative(devSourceRoot, absolutePath).replaceAll("\\", "/");
    return inspectSource(path, readFileSync(absolutePath, "utf8"));
  });
  return currentTreeFindingCache;
}

function renderFindings(findings: readonly DriftFinding[]): string {
  return findings
    .map((finding) =>
      `${finding.verb ? `[${finding.verb}] ` : ""}${finding.path}:${finding.line} controls ${finding.entities.join(", ")}`,
    )
    .join("\n");
}

describe("castle entry-point ownership drift", () => {
  it("ignores the explicit host-adapter path families", () => {
    const hostAdapterSource = `
      export function render(worker: { ticket: number; lane: string; pr: number }) {
        if (worker.ticket && worker.lane && worker.pr) return "host output";
      }
    `;
    const exemptExamples = [
      "cli.ts",
      "commands/statusline.ts",
      "core/hook-dispatcher.ts",
      "platform/skill-paths.ts",
      "commands/codex-monitor-agent.ts",
      "commands/inject-development-workflow.ts",
      "core/development-workflow.ts",
    ];

    expect(exemptExamples.flatMap((path) => inspectSource(path, hostAdapterSource))).toEqual([]);
  });

  it("detects control flow over all four engine entities outside host adapters", () => {
    const findings = inspectSource(
      "core/engine-owner.ts",
      `
        export function decide(worker: { ticket: number; lane: string; pr: number }) {
          if (worker.ticket && worker.lane && worker.pr) return "engine decision";
        }
      `,
    );

    expect(findings).toEqual([
      {
        path: "core/engine-owner.ts",
        line: 3,
        entities: ["Worker", "Ticket", "Lane", "PR"],
      },
    ]);
  });

  it("names the four retained orchestration verb families on today's tree", () => {
    const verbs = [...new Set(currentTreeFindings().flatMap((finding) => finding.verb ?? []))].sort();

    expect(verbs).toEqual(["config", "gate-executor", "landing", "worker-drain"]);
  });

  it.fails("has no dev-local control flow over Worker, Ticket, Lane, or PR entities", () => {
    expect(renderFindings(currentTreeFindings())).toBe("");
  });
});
