// dependency-direction-guard — layering the workspace graph already implies,
// refused in the gate instead of in review.
//
// pnpm and turbo refuse a CYCLE. Neither refuses a DIRECTION: `packages/shared`
// may import `apps/plugin-dev` and the install resolves, the build orders, the
// suite passes. The layering that makes a shared package shared — that nothing
// above it may be reached from inside it — lives today only in the heads of the
// people who review the diff, which is exactly the check that stops happening
// once agents write most of the imports.
//
// ## The table is the rule
//
// `DEPENDENCY_LAYERS` is the ONE declaration: each layer states its rank, the
// workspaces it holds, and what the rank means. Everything a reader or a script
// needs about direction is derived from it — no prose restates the table, so
// there is no second copy to drift. The rule over it is one sentence:
//
//   **An import may only go from a layer to a STRICTLY LOWER one.**
//
// Same-rank is refused too, and deliberately: two workspaces that need each
// other are either one workspace or two ranks, and forcing that answer at the
// moment the edge is written is the whole point. Splitting a layer is a
// one-entry change here.
//
// ## Membership is derived, not hand-kept
//
// A layer names workspaces explicitly only where the rank is a DECISION. A root
// claim (`claimsRoot: "apps"`) sweeps up every workspace the pnpm globs find
// under that root which no layer named, so a NEW app inherits its obligations
// the moment its package.json lands. A workspace that no layer claims at all is
// itself a finding: a new `packages/*` must say where it sits, because that is
// the decision nobody should make silently.
//
// ## What counts as an edge
//
// Both directions a dependency can be written: the `package.json` edge (a
// declared workspace dependency) and the SOURCE edge (an import specifier — a
// bare workspace package name, or a relative path that climbs out of its own
// workspace). The second is the one a manifest audit cannot see, and it is how
// a wrong-direction reach actually arrives: a test that reaches sideways into a
// sibling's `src/` never touches a manifest.

import { dirname, normalize } from "node:path/posix";

/** One layer of the workspace stack: a rank, its members, and what the rank means. */
export interface DependencyLayer {
  /** Short id, used in every finding. */
  readonly id: string;
  /** Position in the stack. An import may only reach a STRICTLY lower rank. */
  readonly rank: number;
  /** Repo-relative workspace dirs this layer holds by name. */
  readonly workspaces: readonly string[];
  /**
   * Workspace root whose members no other layer named fall to this layer, so a
   * new workspace under it inherits the rank instead of going unjudged.
   */
  readonly claimsRoot?: string;
  /** Why the rank is where it is — read by whoever the guard just refused. */
  readonly means: string;
}

/**
 * The declared stack, low to high. This is the source of truth the guard reads;
 * changing where a workspace sits is an edit here and nowhere else.
 */
export const DEPENDENCY_LAYERS: readonly DependencyLayer[] = [
  {
    id: "primitive",
    rank: 0,
    workspaces: ["packages/brand-tokens", "packages/build-info", "packages/cdp-driver"],
    means: "constants and one-purpose drivers that depend on no workspace at all; everything may reach them and they may reach nothing",
  },
  {
    id: "shared",
    rank: 1,
    workspaces: ["packages/shared"],
    means: "the one home for a helper every runtime needs; it may reach primitives and nothing else, because a shared package that reaches upward is not shared",
  },
  {
    id: "wire",
    rank: 2,
    workspaces: [
      "packages/brain-store",
      "packages/browser-bridge",
      "packages/github",
      "packages/protocol-acp",
      "packages/red-skills-link-protocol",
      "packages/redskilled-render",
    ],
    means: "a typed surface onto one outside system — a protocol, an API, a store, a render target; it speaks to the world and must never speak to a runtime that happens to use it",
  },
  {
    id: "engine",
    rank: 3,
    workspaces: ["packages/worker"],
    means: "the Worker body: it composes wires into the turn loop, so it sits above every wire and below every process that places it",
  },
  {
    id: "daemon",
    rank: 4,
    workspaces: ["apps/redskilled"],
    means: "the host-scoped daemon: it is the one thing every runtime talks to, so runtimes may reach it and it may reach none of them",
  },
  {
    id: "runtime",
    rank: 5,
    workspaces: [],
    claimsRoot: "apps",
    means: "a shipped runtime — a plugin, an MCP surface, an extension; nothing in the repo may depend on one, and one may not depend on another",
  },
  {
    id: "benchmark",
    rank: 6,
    workspaces: [],
    claimsRoot: "benchmarks",
    means: "measures the tree from outside it; it may reach anything and nothing may reach it",
  },
];

/** How an edge was written: a declared manifest dependency, or a source import. */
export type DependencyEdgeKind = "manifest" | "import";

/** One dependency from one workspace to another, with where it was written. */
export interface DependencyEdge {
  /** Repo-relative file that wrote the edge (a source file, or a package.json). */
  readonly from: string;
  /** Repo-relative dir of the workspace that owns `from`. */
  readonly fromWorkspace: string;
  /** Repo-relative dir of the workspace reached. */
  readonly toWorkspace: string;
  /** The specifier or dependency name exactly as written. */
  readonly specifier: string;
  readonly kind: DependencyEdgeKind;
  /** 1-based line for a source import; 0 for a manifest dependency. */
  readonly line: number;
}

/** A workspace the pnpm graph found: where it lives and what it is called. */
export interface WorkspaceNode {
  /** Repo-relative dir, e.g. `packages/shared`. */
  readonly dir: string;
  /** The package name its manifest declares, e.g. `@reddb-io/shared`. */
  readonly name: string;
}

/**
 * One edge the stack forbids but the repo still carries. Shrink-only, like every
 * baseline in this tree: drop an entry when the edge goes, never add one — a new
 * entry is the layering violation the guard exists to refuse.
 */
export interface DependencyDirectionException {
  /** Repo-relative file that writes the edge. */
  readonly from: string;
  /** Repo-relative dir of the workspace it reaches. */
  readonly to: string;
  /** Why this one edge stands, and what would remove it. */
  readonly why: string;
}

/** The edges that predate the ratchet. Shrink only. */
export const DEPENDENCY_DIRECTION_EXCEPTIONS: readonly DependencyDirectionException[] = [
  {
    from: "apps/rsp/tests/resident-memory.test.ts",
    to: "apps/plugin-brain",
    why: "rsp's resident-memory suite drives the store surface through the runtime that owns the brain store. It is test arrangement rather than a runtime dependency — rsp's manifest declares no edge to it — and it goes sideways, not upward. It leaves when the suite reaches the store through packages/brain-store instead.",
  },
  {
    from: "apps/rsp/tests/resident-memory.test.ts",
    to: "apps/plugin-memory",
    why: "the same suite reaches the memory runtime's graph store the same way, and leaves the same way: through a wire-layer package rather than a sibling runtime's src/.",
  },
];

export type DependencyDirectionFindingKind =
  | "wrong-direction"
  | "unlayered-workspace"
  | "stale-exception";

export interface DependencyDirectionFinding {
  readonly kind: DependencyDirectionFindingKind;
  /** Repo-relative file the finding points at. */
  readonly from: string;
  readonly fromWorkspace: string;
  readonly toWorkspace: string;
  readonly line: number;
  readonly reason: string;
}

/** The layer that holds `dir`: a named member first, then a root claim. PURE. */
export function layerOfWorkspace(
  dir: string,
  layers: readonly DependencyLayer[] = DEPENDENCY_LAYERS,
): DependencyLayer | undefined {
  const named = layers.find((layer) => layer.workspaces.includes(dir));
  if (named) return named;
  const root = dir.split("/")[0];
  return layers.find((layer) => layer.claimsRoot === root);
}

/**
 * The workspace that owns a repo-relative path — the longest declared dir the
 * path sits inside, so a nested workspace wins over its parent. PURE.
 */
export function workspaceOfPath(
  path: string,
  workspaces: readonly WorkspaceNode[],
): string | undefined {
  let owner: string | undefined;
  for (const node of workspaces) {
    if (path === node.dir || path.startsWith(`${node.dir}/`)) {
      if (owner === undefined || node.dir.length > owner.length) owner = node.dir;
    }
  }
  return owner;
}

/**
 * `text` with every comment replaced by spaces, newlines kept so line numbers
 * still hold. A doc comment that SHOWS an import is documentation, not an edge,
 * and a guard that cannot tell them apart teaches people to stop writing
 * examples. String literals are deliberately left intact — the specifier the
 * guard is looking for is one. PURE.
 */
export function blankComments(text: string): string {
  let out = "";
  let index = 0;
  const modes = { code: 0, line: 1, block: 2, single: 3, double: 4, template: 5 } as const;
  let mode: number = modes.code;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (mode === modes.code) {
      if (char === "/" && next === "/") {
        mode = modes.line;
        out += "  ";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        mode = modes.block;
        out += "  ";
        index += 2;
        continue;
      }
      if (char === "'") mode = modes.single;
      else if (char === '"') mode = modes.double;
      else if (char === "`") mode = modes.template;
      out += char;
      index += 1;
      continue;
    }
    if (mode === modes.line) {
      if (char === "\n") mode = modes.code;
      out += char === "\n" ? char : " ";
      index += 1;
      continue;
    }
    if (mode === modes.block) {
      if (char === "*" && next === "/") {
        mode = modes.code;
        out += "  ";
        index += 2;
        continue;
      }
      out += char === "\n" ? char : " ";
      index += 1;
      continue;
    }
    // Inside a literal: copy through, honour the escape, close on the quote.
    if (char === "\\") {
      out += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (
      (mode === modes.single && char === "'") ||
      (mode === modes.double && char === '"') ||
      (mode === modes.template && char === "`")
    ) {
      mode = modes.code;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** One module specifier a source file names, with the line that wrote it. */
export interface ImportSpecifier {
  readonly specifier: string;
  readonly line: number;
}

const SPECIFIER_PATTERN =
  /(?:^|[\s;})])(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']|(?:^|[^.\w$])(?:import|require)\s*\(\s*["']([^"']+)["']|(?:^|[\s;})])import\s*["']([^"']+)["']/g;

/**
 * Every module specifier `text` imports: static `from` clauses, bare side-effect
 * imports, dynamic `import(...)`, and `require(...)`. Comments are blanked
 * first. A regex rather than a parse, because the question is only "what names
 * does this file reach for" and this runs over the whole tree in every gate. PURE.
 */
export function collectImportSpecifiers(text: string): ImportSpecifier[] {
  const code = blankComments(text);
  const found: ImportSpecifier[] = [];
  for (const match of code.matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier) continue;
    // The pattern eats the separator before the keyword, and that separator is
    // usually the previous line's newline. Count from the keyword itself, so a
    // finding points at the line somebody wrote the import on.
    const start = match.index + (match[0].length - match[0].trimStart().length);
    const line = code.slice(0, start).split("\n").length;
    found.push({ specifier, line });
  }
  return found;
}

/** The bare package name a specifier addresses — `@scope/pkg` or `pkg`. PURE. */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/**
 * The workspace a specifier reaches from `fromPath`, or `undefined` when it
 * reaches outside the workspace graph (a node builtin, an npm dependency, a
 * repo-root script). A relative specifier is resolved against the importing
 * file, which is what catches a reach that climbs out of its own workspace
 * without ever naming a package. PURE. */
export function resolveSpecifierWorkspace(
  specifier: string,
  fromPath: string,
  workspaces: readonly WorkspaceNode[],
): string | undefined {
  if (specifier.startsWith(".")) {
    const resolved = normalize(`${dirname(fromPath)}/${specifier}`);
    return resolved.startsWith("..") ? undefined : workspaceOfPath(resolved, workspaces);
  }
  const name = packageNameOf(specifier);
  return workspaces.find((node) => node.name === name)?.dir;
}

/**
 * The cross-workspace edges one source file writes. An import that stays inside
 * its own workspace, or leaves the graph entirely, is not an edge. PURE. */
export function collectImportEdges(
  text: string,
  fromPath: string,
  workspaces: readonly WorkspaceNode[],
): DependencyEdge[] {
  const owner = workspaceOfPath(fromPath, workspaces);
  if (!owner) return [];
  const edges: DependencyEdge[] = [];
  for (const { specifier, line } of collectImportSpecifiers(text)) {
    const target = resolveSpecifierWorkspace(specifier, fromPath, workspaces);
    if (!target || target === owner) continue;
    edges.push({ from: fromPath, fromWorkspace: owner, toWorkspace: target, specifier, kind: "import", line });
  }
  return edges;
}

/**
 * The cross-workspace edges one manifest declares. `dependencyNames` is every
 * name under `dependencies`, `devDependencies` and `peerDependencies`. PURE. */
export function collectManifestEdges(
  dependencyNames: readonly string[],
  fromWorkspace: string,
  workspaces: readonly WorkspaceNode[],
): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const name of dependencyNames) {
    const target = workspaces.find((node) => node.name === name)?.dir;
    if (!target || target === fromWorkspace) continue;
    edges.push({
      from: `${fromWorkspace}/package.json`,
      fromWorkspace,
      toWorkspace: target,
      specifier: name,
      kind: "manifest",
      line: 0,
    });
  }
  return edges;
}

/** `path:line`, or just the path when the edge has no line (a manifest). */
function where(edge: DependencyEdge): string {
  return edge.line > 0 ? `${edge.from}:${edge.line}` : edge.from;
}

function describeLayer(dir: string, layer: DependencyLayer): string {
  return `${dir} (layer ${layer.id}, rank ${layer.rank})`;
}

/**
 * Judge every edge against the declared stack. Yields a finding for each edge
 * that does not go strictly down, for each workspace no layer claims, and for
 * each declared exception that no longer matches an edge — an inventory nobody
 * prunes is one nobody trusts. PURE. */
export function auditDependencyDirection(
  edges: readonly DependencyEdge[],
  workspaces: readonly WorkspaceNode[],
  layers: readonly DependencyLayer[] = DEPENDENCY_LAYERS,
  exceptions: readonly DependencyDirectionException[] = DEPENDENCY_DIRECTION_EXCEPTIONS,
): DependencyDirectionFinding[] {
  const findings: DependencyDirectionFinding[] = [];

  for (const node of [...workspaces].sort((a, b) => a.dir.localeCompare(b.dir))) {
    if (layerOfWorkspace(node.dir, layers)) continue;
    findings.push({
      kind: "unlayered-workspace",
      from: `${node.dir}/package.json`,
      fromWorkspace: node.dir,
      toWorkspace: "",
      line: 0,
      reason: `${node.dir} is in the pnpm workspace graph but no layer claims it. Give it a rank in DEPENDENCY_LAYERS (apps/plugin-dev/src/core/dependency-direction-guard.ts) — a workspace whose position nobody stated is one every later import may reach in any direction.`,
    });
  }

  const allowed = new Set(exceptions.map((entry) => `${entry.from}::${entry.to}`));
  const used = new Set<string>();
  const ordered = [...edges].sort((a, b) =>
    a.from === b.from ? a.line - b.line || a.specifier.localeCompare(b.specifier) : a.from.localeCompare(b.from),
  );

  for (const edge of ordered) {
    const from = layerOfWorkspace(edge.fromWorkspace, layers);
    const to = layerOfWorkspace(edge.toWorkspace, layers);
    // An unlayered workspace already has its own finding; judging its edges too
    // would bury the one repair under a page of consequences.
    if (!from || !to || from.rank > to.rank) continue;
    const key = `${edge.from}::${edge.toWorkspace}`;
    if (allowed.has(key)) {
      used.add(key);
      continue;
    }
    const relation = from.rank === to.rank ? "sideways" : "upward";
    findings.push({
      kind: "wrong-direction",
      from: edge.from,
      fromWorkspace: edge.fromWorkspace,
      toWorkspace: edge.toWorkspace,
      line: edge.line,
      reason: `${where(edge)} reaches ${relation}: ${describeLayer(edge.fromWorkspace, from)} depends on ${describeLayer(edge.toWorkspace, to)} through ${edge.kind === "manifest" ? "its manifest dependency" : "the import"} "${edge.specifier}". A dependency may only go to a STRICTLY LOWER layer, and ${to.id} is ${from.rank === to.rank ? "the same layer" : "above it"}. ${to.means[0]?.toUpperCase()}${to.means.slice(1)} — so move the shared code down into a lower layer, reach it through one, or split the layer in DEPENDENCY_LAYERS.`,
    });
  }

  for (const entry of exceptions) {
    const key = `${entry.from}::${entry.to}`;
    if (used.has(key)) continue;
    findings.push({
      kind: "stale-exception",
      from: entry.from,
      fromWorkspace: entry.from,
      toWorkspace: entry.to,
      line: 0,
      reason: `The declared exception ${entry.from} → ${entry.to} matches no edge any more. Drop it from DEPENDENCY_DIRECTION_EXCEPTIONS: the list is shrink-only, and leaving a paid-off entry re-authorises the edge the work just removed.`,
    });
  }

  return findings;
}
