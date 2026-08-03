// asked-balance-guard — the ratchet that keeps the GitHub balance ASKED
// (issue #3095, ADR 0132 Amendment 2).
//
// The balance this repo runs on is the answer to `GET /rate_limit`, which reports
// the true remaining budget for the whole token across every machine and costs
// nothing. The design it replaced was a ledger the daemon **accumulates**: every
// caller reports its calls, the daemon totals them. That ledger would have been
// born blind — the daemon is host-scoped by construction while a GitHub quota is
// per token, so an operator running four machines on one token would have had
// four daemons each reporting a quarter of the truth.
//
// **A LOCAL ACCUMULATOR IS THE REGRESSION THIS EXISTS TO PREVENT**, and it will
// arrive dressed as an optimization. Asking is one request; counting is free.
// Somebody reasonable will notice that the daemon already sees every call it
// executes, subtract as it goes, and land a `remaining -= cost` that is correct
// on a single-machine host and wrong by three quarters on the operator's actual
// desk. Nothing else in the tree would fail. The measurement that produced this
// ratchet only became legible because three of four machines happened to be
// switched off mid-session and the numbers suddenly started making sense.
//
// Three rules, mirroring the other ratchets here:
//
//  1. THE SWEPT SET ONLY GROWS. A directory added here is one that has stopped
//     deriving a balance. Removing one admits the derivation back.
//  2. PROSE IS NOT AN ACCUMULATOR. Comments describing what was removed —
//     including this one — are documentation, so comments are stripped before
//     matching.
//  3. READING IS NOT DERIVING. `remaining` copied out of an answer is the whole
//     point; only ACCUMULATION fails — a compound assignment, an increment, or a
//     self-referential `x = x ± n` on a quota-named binding.
//
// The positive half matters as much as the negative one: `GithubBalance.origin`
// is the single literal `"asked"`, so a counting path cannot construct a balance
// without declaring an origin that does not exist. This guard pins that literal,
// because a union widened to `"asked" | "derived"` would reopen the door in one
// line and read as a feature.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** One directory swept for a locally-accumulated GitHub balance. */
export interface AskedBalanceScope {
  /** Repo-relative directory. */
  dir: string;
  /** Why this code is close enough to the balance to be worth sweeping. */
  why: string;
}

/**
 * The swept set: everything that touches the GitHub budget.
 *
 * `packages/github` owns the balance; `apps/redskilled/src` holds the one poller
 * and the token; `apps/dev/src/runtime/gh` is the read boundary that spends the
 * budget and is the most natural place for a well-meaning subtraction to appear.
 */
export const ASKED_BALANCE_SCOPES: readonly AskedBalanceScope[] = [
  { dir: "packages/github", why: "the budget-aware client owns the balance and its postures" },
  { dir: "apps/redskilled/src", why: "the daemon holds the one token and the one balance poller" },
  { dir: "apps/dev/src/runtime/gh", why: "the read boundary spends the budget every Worker iteration" },
];

/**
 * The file whose `origin` literal is the type-level half of the invariant, and
 * the exact declaration it must carry.
 */
export const ASKED_BALANCE_ORIGIN_FILE = "packages/github/balance.ts";
/** The declaration that refuses a derived balance at compile time. */
export const ASKED_BALANCE_ORIGIN_DECLARATION = 'readonly origin: "asked";';

/**
 * Identifier stems that name a GitHub budget quantity.
 *
 * Deliberately narrow. A guard that reddened every `count` would be turned off
 * within a week, and the accumulation that matters is always spelled with one of
 * these nouns because it is the balance the accumulator is trying to track.
 */
const QUOTA_NOUNS = [
  "remaining",
  "ratelimit",
  "rate_limit",
  "quota",
  "balance",
  "points",
  "budgetspent",
  "budget_spent",
  "pointsspent",
  "points_spent",
] as const;

/** One place a balance is derived by counting rather than by asking. */
export interface DerivedBalanceSite {
  /** Repo-relative path. */
  path: string;
  /** 1-indexed line. */
  line: number;
  /** The binding being accumulated. */
  binding: string;
  /** The offending source line, trimmed. */
  text: string;
  /** What to do instead, named concretely enough to act on. */
  route: string;
}

const ROUTE =
  "ask `GET /rate_limit` through `fetchGithubBalance` in packages/github/balance.ts — the token's balance is " +
  "cross-host and this process only ever sees its own share of it (ADR 0132 Amendment 2)";

/**
 * Strip comments so prose describing an accumulator does not read as one. PURE.
 *
 * Line comments and block comments only; string contents are left alone, because
 * a compound assignment inside a string literal is not a thing this repo writes
 * and stripping strings would need a parser.
 */
export function stripSourceComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_match, prefix: string) => prefix);
}

function namesQuota(binding: string): boolean {
  const lowered = binding.toLowerCase();
  return QUOTA_NOUNS.some((noun) => lowered.includes(noun));
}

/**
 * Every accumulation of a quota-named binding in one file. PURE.
 *
 * Three shapes, which is all an accumulator can be: `x += n`, `x++`, and the
 * self-referential `x = x - n` that a linter-shy author writes instead.
 */
export function findDerivedBalanceSites(path: string, source: string): DerivedBalanceSite[] {
  const sites: DerivedBalanceSite[] = [];
  const lines = stripSourceComments(source).split("\n");
  lines.forEach((line, index) => {
    const compound = /\b([A-Za-z_$][\w$.]*)\s*(?:\+=|-=)\s*[^=]/.exec(line);
    const increment = /\b([A-Za-z_$][\w$.]*)\s*(?:\+\+|--)/.exec(line);
    const selfRef = /\b([A-Za-z_$][\w$.]*)\s*=\s*[^=;]*?\b([A-Za-z_$][\w$.]*)\s*[-+]\s*/.exec(line);
    const binding =
      (compound && namesQuota(compound[1]!) && compound[1]) ||
      (increment && namesQuota(increment[1]!) && increment[1]) ||
      (selfRef && selfRef[1] === selfRef[2] && namesQuota(selfRef[1]!) && selfRef[1]) ||
      null;
    if (binding == null) return;
    sites.push({
      path,
      line: index + 1,
      binding,
      text: line.trim(),
      route: ROUTE,
    });
  });
  return sites;
}

/** Every `.ts` source file under `dir`, tests excluded. PURE apart from the walk. */
export function askedBalanceSources(repoRoot: string, dir: string): string[] {
  const absolute = join(repoRoot, dir);
  const found: string[] = [];
  const walk = (current: string): void => {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const full = join(current, name);
      const info = statSync(full);
      if (info.isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.endsWith(".d.ts")) continue;
      found.push(full);
    }
  };
  walk(absolute);
  return found;
}

/**
 * Sweep every declared scope. Impure only in reading the tree.
 *
 * This guard's own module is excluded by construction — it lives outside every
 * swept directory — so the nouns it names cannot fail it.
 */
export function sweepAskedBalance(
  repoRoot: string,
  scopes: readonly AskedBalanceScope[] = ASKED_BALANCE_SCOPES,
): DerivedBalanceSite[] {
  const sites: DerivedBalanceSite[] = [];
  for (const scope of scopes) {
    for (const file of askedBalanceSources(repoRoot, scope.dir)) {
      const relative = file.slice(repoRoot.length + 1);
      sites.push(...findDerivedBalanceSites(relative, readFileSync(file, "utf8")));
    }
  }
  return sites;
}

/** One sentence per offending site, naming the route rather than only refusing. */
export function renderDerivedBalanceSites(sites: readonly DerivedBalanceSite[]): string {
  return sites
    .map(
      (site) =>
        `${site.path}:${site.line} accumulates ${JSON.stringify(site.binding)} (${site.text})\n  → ${site.route}`,
    )
    .join("\n");
}
