/**
 * semantic-authority.ts — who answers "where is this symbol defined?" for a
 * generated host surface.
 *
 * The navigator MCP exists because Claude Code, Codex, and a bare OpenCode
 * have no semantic index of their own: it spawns `typescript-language-server`,
 * `gopls`, `rust-analyzer` and friends and speaks LSP on the agent's behalf.
 * RedCode already runs that stack natively, so projecting navigator onto it
 * births a SECOND language server over the same tree and the same files —
 * double the memory, double the indexing wall-clock, and two answers that can
 * disagree while both look authoritative.
 *
 * The rule is stated once here, as a table plus an operator override, so every
 * emit path (the standalone Slice 1 file and the Slice 2 dist tree) defers the
 * same way rather than each caller re-deciding. Deferral is CONDITIONAL on the
 * native authority actually being available: a RedCode install whose native
 * LSP is switched off keeps navigator, because the alternative is a host with
 * no semantic navigation at all.
 */
import type { McpPlan } from "./mcp-passthrough.js";

/** The OpenCode-compatible hosts the generator emits for. */
export const HOST_TARGETS = ["opencode", "redcode"] as const;

export type HostTarget = (typeof HOST_TARGETS)[number];

/**
 * Hosts that ship their own LSP stack. `true` means the host answers
 * navigation natively, so a navigator projection would be the duplicate.
 */
const NATIVE_SEMANTIC_HOSTS: Record<HostTarget, boolean> = {
  opencode: false,
  redcode: true,
};

/**
 * MCP servers whose whole job is semantic navigation over a language-server
 * stack. Named rather than pattern-matched: a host with native LSP defers
 * exactly these and keeps every other MCP the plugins ship.
 */
export const NAVIGATOR_MCP_NAMES: readonly string[] = ["navigator"];

/** True when `name` is a navigator-class MCP a native LSP already answers. */
export function isNavigatorMcp(name: string): boolean {
  return NAVIGATOR_MCP_NAMES.includes(name);
}

/** True when `value` names a host the generator knows how to emit for. */
export function isHostTarget(value: string): value is HostTarget {
  return (HOST_TARGETS as readonly string[]).includes(value);
}

/** Who owns semantic navigation for one generated host surface. */
export interface SemanticAuthority {
  host: HostTarget;
  /** True when the host's own LSP answers navigation for the opened tree. */
  nativeLsp: boolean;
}

/**
 * Resolve the authority for `host`. `override` is the operator's explicit
 * `--native-lsp` / `--no-native-lsp`; absent, the host table decides.
 */
export function resolveSemanticAuthority(
  host: HostTarget,
  override?: boolean,
): SemanticAuthority {
  return { host, nativeLsp: override ?? NATIVE_SEMANTIC_HOSTS[host] };
}

/** True when navigator must be left to the host's own LSP. */
export function defersNavigation(authority: SemanticAuthority): boolean {
  return authority.nativeLsp;
}

/** The plans that survive, plus the names deferred to the host's own LSP. */
export interface AppliedAuthority {
  plans: McpPlan[];
  /** MCP names dropped because the host answers them natively. */
  deferred: string[];
}

/**
 * Drop the navigator-class plans a native-LSP host already answers. The plan
 * is omitted rather than emitted `enabled: false`: an entry that carries the
 * launcher command is one flag away from birthing the duplicate stack, and the
 * generated file is regenerated on every install anyway.
 */
export function applySemanticAuthority(
  plans: readonly McpPlan[],
  authority: SemanticAuthority,
): AppliedAuthority {
  if (!defersNavigation(authority)) return { plans: [...plans], deferred: [] };
  const kept: McpPlan[] = [];
  const deferred: string[] = [];
  for (const plan of plans) {
    if (isNavigatorMcp(plan.name)) deferred.push(plan.name);
    else kept.push(plan);
  }
  return { plans: kept, deferred };
}
