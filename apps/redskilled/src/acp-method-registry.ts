// acp-method-registry — one table, one module per `_redskills/*` domain.
//
// The control plane used to bind every extension method itself, twice: once on
// the v1 app and once on the v2 app, as two hand-kept chains of `.onRequest`.
// Two chains is the shape a method goes missing from — a binding added to one
// and forgotten on the other is a method that answers on one dialect and 404s
// on the other, and nothing fails until a peer that speaks the other dialect
// asks. So the bindings become DATA: each domain module declares its own, the
// table composes them, and both dialects are registered from the same list.
//
// A domain also declares the `_meta.redskills` fragment it contributes to
// `initialize`, because advertising a method the endpoint does not bind (and
// binding one it never advertises) are the same drift in the other direction.
import { REDSKILLS_ACP_METHODS, type RedskillsAcpMethod } from "@reddb-io/protocol-acp";

/** The context an extension handler is given. Params are already validated. */
export interface RedskillsAcpMethodContext<Params = unknown> {
  readonly params: Params;
  /** The peer on the other end of THIS connection, in its own dialect. */
  readonly client: unknown;
}

/** One method: its name, its params validator, and the handler behind it. */
export interface RedskillsAcpMethodBinding {
  readonly method: RedskillsAcpMethod;
  readonly params: (value: unknown) => unknown;
  readonly handle: (context: RedskillsAcpMethodContext) => unknown;
}

/** Every `_redskills/*` domain the daemon knows, control-plane served or not. */
export type RedskillsAcpMethodDomainName = "host" | "project" | "github" | "budget" | "go" | "worker";

/** One domain's contribution: its bindings and what `initialize` advertises. */
export interface RedskillsAcpMethodDomain {
  readonly domain: RedskillsAcpMethodDomainName;
  readonly bindings: readonly RedskillsAcpMethodBinding[];
  /** Merged into `_meta.redskills` on `initialize`; absent when nothing is advertised. */
  readonly capability?: Readonly<Record<string, unknown>>;
}

/**
 * Declare one method binding.
 *
 * The helper exists for its TYPES: `params` narrows `unknown` to the handler's
 * shape exactly once, here, so a domain module writes an ordinary typed handler
 * and the table stores an erased one. Without it every domain would restate the
 * same cast, which is the same as having no validator at all.
 */
export function redskillsAcpMethod<Params, Result>(
  method: RedskillsAcpMethod,
  params: (value: unknown) => Params,
  handle: (context: RedskillsAcpMethodContext<Params>) => Result,
): RedskillsAcpMethodBinding {
  return {
    method,
    params,
    handle: handle as (context: RedskillsAcpMethodContext) => unknown,
  };
}

/**
 * Params of a method whose whole request is its name.
 *
 * Deliberately permissive where the strict `emptyRedskillsParams` is not: these
 * methods have accepted any object since they existed, and tightening them is a
 * wire change owed its own slice, not a side effect of moving the binding.
 */
export const acpNoParams = (): Record<string, never> => ({});

/** The composed control-plane surface: what to bind, and what to advertise. */
export interface RedskillsAcpMethodTable {
  readonly bindings: readonly RedskillsAcpMethodBinding[];
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly domains: readonly RedskillsAcpMethodDomainName[];
}

/**
 * Compose the declared domains into the one table both dialects register from.
 *
 * A method claimed twice is refused at composition, not at request time: two
 * handlers for one name means whichever domain registered last silently wins,
 * and the loser's authority checks never run.
 */
export function redskillsAcpMethodTable(
  domains: readonly RedskillsAcpMethodDomain[],
): RedskillsAcpMethodTable {
  const bindings: RedskillsAcpMethodBinding[] = [];
  const claimed = new Map<string, RedskillsAcpMethodDomainName>();
  let capabilities: Record<string, unknown> = {};
  for (const domain of domains) {
    for (const binding of domain.bindings) {
      const holder = claimed.get(binding.method);
      if (holder != null) {
        throw new Error(`${binding.method} is claimed by both the ${holder} and ${domain.domain} ACP domains`);
      }
      claimed.set(binding.method, domain.domain);
      bindings.push(binding);
    }
    if (domain.capability != null) capabilities = { ...capabilities, ...domain.capability };
  }
  return { bindings, capabilities, domains: domains.map((domain) => domain.domain) };
}

/**
 * The module that owns each domain, and the method keys it owns.
 *
 * Declared here rather than discovered, so `apps/redskilled/tests/acp-control-plane-layout.test.ts`
 * can pin ONE module per domain and refuse a method with no home. `served`
 * states whether the public control plane binds the domain: `worker_budget_grace`
 * travels daemon → Worker and is answered by the Worker, so it has an owner and
 * no control-plane binding.
 */
export interface RedskillsAcpMethodDomainDeclaration {
  readonly domain: RedskillsAcpMethodDomainName;
  /** Repo-relative module, under `apps/redskilled/src/`, that owns the domain. */
  readonly module: string;
  /** Keys of `REDSKILLS_ACP_METHODS` this domain owns. */
  readonly methods: readonly (keyof typeof REDSKILLS_ACP_METHODS)[];
  /** True when the public control plane binds this domain's methods. */
  readonly served: boolean;
}

export const REDSKILLS_ACP_METHOD_DOMAINS: readonly RedskillsAcpMethodDomainDeclaration[] = [
  { domain: "host", module: "acp-host-methods.ts", methods: ["hostState"], served: true },
  {
    domain: "project",
    module: "project-control.ts",
    methods: ["projectDrain", "projectStop", "projectStatus"],
    served: true,
  },
  {
    domain: "github",
    module: "acp-github.ts",
    methods: ["githubRead", "githubWrite", "githubUpdate", "githubCustodyHandoff"],
    served: true,
  },
  { domain: "budget", module: "acp-budget.ts", methods: ["projectBudget", "hostBudgets"], served: true },
  { domain: "go", module: "acp-go-dispatch.ts", methods: ["goDispatch"], served: true },
  {
    domain: "worker",
    module: "acp-worker-budget-grace.ts",
    methods: ["workerBudgetGrace"],
    served: false,
  },
];
