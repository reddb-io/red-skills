import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const devSourceRoot = resolve(here, "../../src");

/**
 * Known host-facing functions whose control flow renders or wires castle data.
 * The exemption is deliberately scoped to named functions, never whole files.
 */
const HOST_ADAPTER_BOUNDARIES = [
  {
    path: "commands/statusline.ts",
    functions: ["resolveProject", "statuslineCommand"],
  },
  {
    path: "core/statusline.ts",
    functions: [
      "renderProjectBlock",
      "afkTokens",
      "renderRepoBlock",
      "renderShortRepoBlock",
      "renderFleetBlock",
      "renderStatuslineWithPreset",
    ],
  },
  {
    path: "runtime/wire/statusline-cache.ts",
    functions: ["inferGitHubRepoSlug", "applyStatuslineCountCacheLabelDelta"],
  },
  {
    path: "runtime/wire/statusline.ts",
    functions: ["collectStatuslineAfk", "collectStatuslineFleet"],
  },
  {
    path: "core/hook-config.ts",
    functions: ["compareFilenames"],
  },
  {
    path: "core/hook-dispatcher.ts",
    functions: ["deriveHookEnv"],
  },
  {
    path: "platform/skill-paths.ts",
    functions: ["skillDirFromModule"],
  },
  {
    path: "commands/codex-monitor-agent.ts",
    functions: ["parseMode"],
  },
  {
    path: "core/codex-monitor-agent.ts",
    functions: ["decideCodexMonitorAgent"],
  },
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

export type EngineEntity = "Worker" | "Ticket" | "Lane" | "PR";
export type EngineVerb = keyof typeof ENGINE_VERB_PATHS;

export interface DriftFinding {
  path: string;
  line: number;
  entities: EngineEntity[];
  verb?: EngineVerb;
}

const ENTITY_TOKENS: Record<EngineEntity, ReadonlySet<string>> = {
  Worker: new Set(["worker", "workers", "supervisor", "supervisors", "fleet"]),
  Ticket: new Set(["ticket", "tickets", "issue", "issues"]),
  Lane: new Set(["lane", "lanes", "queue", "queues", "claim", "claims", "lease", "leases"]),
  PR: new Set(["pr", "prs", "pullrequest"]),
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

function declaredFunctionName(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name?.getText(sourceFile);
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    if (ts.isVariableDeclaration(node.parent)) return node.parent.name.getText(sourceFile);
    if (ts.isPropertyAssignment(node.parent)) return node.parent.name.getText(sourceFile);
  }
  return undefined;
}

function isAllowedHostAdapterControl(
  path: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
): boolean {
  const boundary = HOST_ADAPTER_BOUNDARIES.find((candidate) => candidate.path === path);
  if (!boundary) return false;
  const allowedFunctions = new Set<string>(boundary.functions);
  for (let ancestor: ts.Node | undefined = node; ancestor; ancestor = ancestor.parent) {
    const name = declaredFunctionName(ancestor, sourceFile);
    if (name && allowedFunctions.has(name)) return true;
  }
  return false;
}

function identifierTermsIn(node: ts.Node, sourceFile: ts.SourceFile): string[][] {
  const identifiers: string[][] = [];
  const collect = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) {
      const terms = child
        .getText(sourceFile)
        .split(/[^a-zA-Z0-9]+|(?=[A-Z])/)
        .filter(Boolean)
        .map((term) => term.toLowerCase());
      if (terms.length > 0) identifiers.push(terms);
    }
    ts.forEachChild(child, collect);
  };
  collect(node);
  return identifiers;
}

function entitiesIn(nodes: readonly ts.Node[], sourceFile: ts.SourceFile): EngineEntity[] {
  const identifiers = nodes.flatMap((node) => identifierTermsIn(node, sourceFile));
  const tokens = new Set(identifiers.flat());
  const hasPullRequestSequence = identifiers.some((terms) =>
    terms.some((term, index) => term === "pull" && terms[index + 1] === "request"),
  );

  return (Object.entries(ENTITY_TOKENS) as Array<[EngineEntity, ReadonlySet<string>]>).flatMap(
    ([entity, entityTokens]) =>
      [...tokens].some((token) => entityTokens.has(token)) ||
      (entity === "PR" && hasPullRequestSequence)
        ? [entity]
        : [],
  );
}

export function inspectSource(path: string, source: string): DriftFinding[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const entities = new Set<EngineEntity>();
  let firstLine: number | undefined;
  const visit = (node: ts.Node): void => {
    const controls = controllingNodes(node);
    if (controls.length > 0 && !isAllowedHostAdapterControl(path, node, sourceFile)) {
      const controlledEntities = entitiesIn(controls, sourceFile);
      if (controlledEntities.length > 0) {
        firstLine ??= sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        for (const entity of controlledEntities) entities.add(entity);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (firstLine === undefined) return [];
  const verb = engineVerbFor(path);
  return [{ path, line: firstLine, entities: [...entities], ...(verb ? { verb } : {}) }];
}

let currentTreeFindingCache: DriftFinding[] | undefined;
let currentTreeSourcePathCache: string[] | undefined;

function currentTreeSourcePaths(): string[] {
  currentTreeSourcePathCache ??= sourceFilesUnder(devSourceRoot).map((absolutePath) =>
    relative(devSourceRoot, absolutePath).replaceAll("\\", "/"),
  );
  return currentTreeSourcePathCache;
}

export function currentTreeFindings(): DriftFinding[] {
  currentTreeFindingCache ??= currentTreeSourcePaths().flatMap((path) => {
    const absolutePath = resolve(devSourceRoot, path);
    return inspectSource(path, readFileSync(absolutePath, "utf8"));
  });
  return currentTreeFindingCache;
}

export function currentTreeEngineVerbs(): EngineVerb[] {
  const paths = new Set(currentTreeSourcePaths());
  return (Object.entries(ENGINE_VERB_PATHS) as Array<[EngineVerb, readonly string[]]>)
    .flatMap(([verb, verbPaths]) => (verbPaths.some((path) => paths.has(path)) ? [verb] : []))
    .sort();
}

export function renderFindings(findings: readonly DriftFinding[]): string {
  return findings
    .map((finding) =>
      `${finding.verb ? `[${finding.verb}] ` : ""}${finding.path}:${finding.line} controls ${finding.entities.join(", ")}`,
    )
    .join("\n");
}
