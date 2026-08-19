import type { ConfigCoherenceProbeInput, OperationalProbe, OperationalProbeResult } from "./types.js";

const CANONICAL_FIX =
  "Repair malformed .red/config.yaml syntax, or relocate root-level dev-plugin settings under plugins.dev.* after reviewing the diff preview.";

interface ConfigCoherenceRepairPlan {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly diff: string;
}

function ok(input: ConfigCoherenceProbeInput): OperationalProbeResult {
  return {
    id: "config.coherence",
    name: "Config coherence",
    verdict: "ok",
    evidence:
      `loaded ${input.displayPath}; resolved trunk=${input.resolved.trunk} ` +
      `gate=${input.resolved.gate || "<unset>"} lock=${input.resolved.lock || "<unset>"}; every canonical key resolved`,
    canonicalFix: CANONICAL_FIX,
  };
}

function malformed(input: ConfigCoherenceProbeInput): OperationalProbeResult {
  const failure = input.parseFailure;
  const line = failure?.line ? `line ${failure.line}` : "unknown line";
  const construct = failure?.construct ?? failure?.message ?? "malformed YAML";
  return {
    id: "config.coherence",
    name: "Config coherence",
    verdict: "red",
    evidence:
      `loaded ${input.displayPath} then discarded it; offending ${line}: ${construct}; ` +
      `runtime fell back to defaults`,
    canonicalFix: `Repair ${input.displayPath} at ${line} (${construct}); boot must not continue on default trunk.`,
  };
}

function rootsToRelocate(input: ConfigCoherenceProbeInput): string[] {
  const roots = new Set<string>();
  for (const collision of input.rootAccessorCollisions) {
    if (collision.key.startsWith("afk.")) roots.add("afk");
    if (collision.key.startsWith("dev.")) roots.add("dev");
  }
  return [...roots].sort();
}

function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = text.endsWith("\n");
  const lines = trailingNewline ? text.slice(0, -1).split("\n") : text.split("\n");
  return { lines: lines.length === 1 && lines[0] === "" ? [] : lines, trailingNewline };
}

function isTopLevelKey(line: string, key: string): boolean {
  return new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line);
}

function extractTopLevelBlock(lines: readonly string[], key: string): { block: string[]; indexes: Set<number> } {
  const indexes = new Set<number>();
  const block: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isTopLevelKey(lines[i]!, key)) continue;
    block.push(lines[i]!);
    indexes.add(i);
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]!;
      if (/^[A-Za-z_][A-Za-z0-9_-]*:/.test(line)) break;
      block.push(line);
      indexes.add(j);
    }
    break;
  }
  return { block, indexes };
}

function indent(lines: readonly string[], spaces: number): string[] {
  const prefix = " ".repeat(spaces);
  return lines.map((line) => (line === "" ? line : `${prefix}${line}`));
}

function unifiedDiff(before: string, after: string, path: string): string {
  const beforeLines = splitLines(before).lines;
  const afterLines = splitLines(after).lines;
  return [
    `--- ${path}`,
    `+++ ${path}`,
    "@@",
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function planCanonicalRelocation(input: ConfigCoherenceProbeInput, currentText: string): ConfigCoherenceRepairPlan | null {
  const roots = rootsToRelocate(input);
  if (roots.length === 0) return null;
  if (/^plugins:\s*(?:#.*)?$/m.test(currentText)) return null;

  const { lines, trailingNewline } = splitLines(currentText);
  const removed = new Set<number>();
  const devChildren: string[] = [];
  const afkBlock: string[] = [];
  for (const root of roots) {
    const extracted = extractTopLevelBlock(lines, root);
    if (extracted.block.length === 0) continue;
    for (const index of extracted.indexes) removed.add(index);
    if (root === "dev") devChildren.push(...extracted.block.slice(1));
    if (root === "afk") afkBlock.push(...extracted.block);
  }
  if (removed.size === 0) return null;

  const remaining = lines.filter((_line, index) => !removed.has(index));
  const relocated = ["plugins:", "  dev:", ...indent(devChildren, 2), ...indent(afkBlock, 4)];
  const afterLines = [...remaining, ...(remaining.length > 0 ? [""] : []), ...relocated];
  const after = `${afterLines.join("\n")}${trailingNewline ? "\n" : ""}`;
  return {
    path: input.path,
    before: currentText,
    after,
    diff: unifiedDiff(currentText, after, input.displayPath),
  };
}

export const configCoherenceProbe: OperationalProbe = {
  id: "config.coherence",
  name: "Config coherence",
  canonicalFix: CANONICAL_FIX,
  run(context): OperationalProbeResult {
    const input = context.configCoherence;
    if (!input) {
      return {
        id: this.id,
        name: this.name,
        verdict: "ok",
        evidence: "no config audit facts supplied",
        canonicalFix: this.canonicalFix,
      };
    }
    if (input.discarded) return malformed(input);
    if (input.rootAccessorCollisions.length === 0) return ok(input);

    const rootKeys = input.rootAccessorCollisions.map((collision) => collision.key).join(", ");
    const canonicalKeys = input.rootAccessorCollisions.map((collision) => collision.canonicalKey).join(", ");
    const plan = input.sourceText ? planCanonicalRelocation(input, input.sourceText) : null;
    return {
      id: this.id,
      name: this.name,
      verdict: "red",
      evidence: `loaded ${input.displayPath}; root-level ${rootKeys} is off-contract; canonical relocation ${canonicalKeys}`,
      canonicalFix: `Relocate ${rootKeys} to ${canonicalKeys} in ${input.displayPath} after reviewing the diff preview.`,
      fix: plan ? { gate: "confirm", description: "Preview and apply canonical config relocation." } : undefined,
      data: { repairPlan: plan },
    };
  },
  async applyFix(finding, deps) {
    const plan = (finding.data as { repairPlan?: ConfigCoherenceRepairPlan | null } | undefined)?.repairPlan;
    if (!plan) return { probeId: finding.id, status: "noop", evidence: "no automatic config relocation is available" };
    const current = await deps.readText?.(plan.path);
    if (current === undefined || current === null) {
      return { probeId: finding.id, status: "noop", evidence: "config file read repair is not wired" };
    }
    await deps.showDiffPreview?.(finding, plan.diff);
    if (!(await deps.confirm(finding))) return { probeId: finding.id, status: "declined", evidence: "operator declined fix" };
    if (!deps.writeText) return { probeId: finding.id, status: "noop", evidence: "config file write repair is not wired" };
    if (current !== plan.before) return { probeId: finding.id, status: "noop", evidence: "config file changed since preview" };
    await deps.writeText(plan.path, plan.after);
    return { probeId: finding.id, status: "applied", evidence: "relocated root-level config under plugins.dev" };
  },
};
