// worktree — the wire shape of `_redskills/worktree_add` and
// `_redskills/worktree_list` (ADR 0150 §4).
//
// The interactive Working mode used to be the one mode nothing coordinated: a
// human typed `git worktree add` into whichever checkout they were standing in,
// and the resulting worktree existed in no inventory the daemon could answer
// from. Worker worktrees, meanwhile, live in OS temporary storage (ADR 0149)
// and are known only to the daemon. Two half-inventories is the shape a
// worktree is forgotten in — so `worktree_list` becomes the ONE inventory, and
// `worktree_add` is how an interactive worktree enters it.
//
// What lives here is the WIRE and only the wire: what a caller may name, what
// it reads back, the published schemas both ends validate against, and the
// refusal vocabulary a client can branch on. WHICH lane an interactive worktree
// lands in, WHICH trunk it forks from, and WHAT counts as registered are daemon
// verdicts and stay with the daemon, per ADR 0148's body-versus-control cut.
import { RequestError } from "@agentclientprotocol/sdk";

import { REDSKILLS_ACP_METHODS } from "./methods.js";

/**
 * Everything a `worktree_add` caller may name.
 *
 * No checkout, no lane, no project: the daemon works in the checkout the
 * caller's connection registered, and a params shape that let a caller name a
 * different one would be the client-composed launch ADR 0144 §5 forbids,
 * wearing a wire. `base` names a BRANCH, never a ref — the remote is the
 * Project's registered trunk remote, so a caller cannot redirect the fork at a
 * local ref that trails it.
 */
export interface WorktreeAddParams {
  /** What the human is about to work on; becomes the directory name. */
  readonly slug: string;
  /** Branch to create. Defaults to the daemon's convention for the slug. */
  readonly branch?: string;
  /** Trunk branch to fork from. Defaults to the Project's registered trunk. */
  readonly base?: string;
}

/** How a worktree in the inventory came to exist. */
export type WorktreeKind =
  /** The registered client checkout itself — the anchor every other entry hangs off. */
  | "checkout"
  /** A human's worktree in a registered lane of that checkout. */
  | "interactive"
  /** A Worker's worktree, coordinated by the daemon in its own storage. */
  | "worker"
  /** A worktree of this checkout in no lane anybody registered. */
  | "unregistered";

/** One worktree, however it was born. */
export interface WorktreeEntry {
  readonly kind: WorktreeKind;
  /** Absolute path, as the authority that knows this worktree reports it. */
  readonly path: string;
  /** Checked-out branch; `null` for a detached head or a path git detached from. */
  readonly branch: string | null;
  /** The registered lane, present only for a worktree that lies in one. */
  readonly lane?: string;
  /** The Worker that owns this worktree, present only for `worker`. */
  readonly worker_id?: string;
}

/** What one accepted `worktree_add` created. */
export interface WorktreeAddAnswer {
  readonly version: 1;
  /** Always `interactive`: the method exists to create a human's worktree. */
  readonly kind: "interactive";
  readonly path: string;
  readonly branch: string;
  /** The remote ref the worktree was forked from, after a fresh fetch. */
  readonly base: string;
  readonly lane: string;
  readonly project_label: string;
}

/** The one inventory: every worktree of this Project either authority knows. */
export interface WorktreeListAnswer {
  readonly version: 1;
  readonly project_label: string;
  readonly worktrees: readonly WorktreeEntry[];
}

/**
 * Why the daemon refused, as a name rather than as a sentence.
 *
 * A refusal a client can only regex out of a message is a refusal no client
 * branches on, so each reason is a value: `checkout-not-registered` is the
 * caller's own repair (register the Project first), `trunk-unknown` is a
 * registration too old to state its git coordinates, and `slug-unusable` /
 * `ref-unusable` are the caller's own strings refused before they reach git's
 * argv.
 */
export const WORKTREE_REFUSAL_REASONS = {
  checkoutNotRegistered: "checkout-not-registered",
  trunkUnknown: "trunk-unknown",
  slugUnusable: "slug-unusable",
  refUnusable: "ref-unusable",
} as const;

export type WorktreeRefusalReason =
  (typeof WORKTREE_REFUSAL_REASONS)[keyof typeof WORKTREE_REFUSAL_REASONS];

/**
 * The daemon's verdict: the request was well formed and is still refused.
 *
 * `reason` travels in the error DATA, where a client reads it without parsing
 * prose; `detail` travels as the message, where a human reads it. Neither is
 * derived from the other, because a reason narrowed to fit a sentence stops
 * being a value and a sentence widened to carry a reason stops being readable.
 */
export function worktreeRefusal(reason: WorktreeRefusalReason, detail: string): RequestError {
  return RequestError.invalidRequest({ reason, detail }, detail);
}

/**
 * The caller's own string was refused, in the same readable shape.
 *
 * Separate from {@link worktreeRefusal} because the two are different verdicts
 * and JSON-RPC already distinguishes them: an unusable slug is the caller's
 * params to fix, while an unregistered checkout is the daemon's authority
 * speaking about a well-formed request. The `{ reason, detail }` data shape is
 * shared so a client reads one field either way.
 */
export function worktreeParamsRefusal(reason: WorktreeRefusalReason, detail: string): RequestError {
  return RequestError.invalidParams({ reason, detail }, detail);
}

/** Longest slug the wire accepts; it becomes a directory name on every platform. */
export const WORKTREE_SLUG_MAX_LENGTH = 64;

/** Longest branch or base name the wire accepts. */
export const WORKTREE_REF_MAX_LENGTH = 200;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * A branch or base name git can be handed as argv without ambiguity.
 *
 * The refused set is git's own (`refname` rules) plus the one shell-free
 * hazard argv still carries: a leading `-`, which git reads as an OPTION. A
 * caller that names `--upload-pack=…` is not naming a branch.
 */
function refIsUsable(value: string): boolean {
  if (value === "" || value.length > WORKTREE_REF_MAX_LENGTH) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) return false;
  if (value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{")) return false;
  if (/[\s~^:?*[\\]/.test(value)) return false;
  return ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

/** The published `worktree_add` params schema; the daemon and every client read this one. */
export const WORKTREE_ADD_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["slug"],
  properties: {
    slug: {
      type: "string",
      minLength: 1,
      maxLength: WORKTREE_SLUG_MAX_LENGTH,
      pattern: SLUG_PATTERN.source,
      description: "What the human is about to work on; becomes the worktree directory name.",
    },
    branch: {
      type: "string",
      minLength: 1,
      maxLength: WORKTREE_REF_MAX_LENGTH,
      description: "Branch to create; defaults to the daemon's convention for the slug.",
    },
    base: {
      type: "string",
      minLength: 1,
      maxLength: WORKTREE_REF_MAX_LENGTH,
      description: "Trunk BRANCH to fork from; the remote is the Project's registered trunk remote.",
    },
  },
} as const;

/** The published `worktree_add` answer schema. */
export const WORKTREE_ADD_ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "kind", "path", "branch", "base", "lane", "project_label"],
  properties: {
    version: { const: 1 },
    kind: { const: "interactive" },
    path: { type: "string", minLength: 1 },
    branch: { type: "string", minLength: 1 },
    base: { type: "string", minLength: 1 },
    lane: { type: "string", minLength: 1 },
    project_label: { type: "string", minLength: 1 },
  },
} as const;

/** The published `worktree_list` answer schema. */
export const WORKTREE_LIST_ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "project_label", "worktrees"],
  properties: {
    version: { const: 1 },
    project_label: { type: "string", minLength: 1 },
    worktrees: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "path", "branch"],
        properties: {
          kind: { enum: ["checkout", "interactive", "worker", "unregistered"] },
          path: { type: "string", minLength: 1 },
          branch: { type: ["string", "null"] },
          lane: { type: "string", minLength: 1 },
          worker_id: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

/** The whole published contract of the two worktree methods, in one value. */
export const WORKTREE_SCHEMA = {
  version: 1,
  methods: {
    add: REDSKILLS_ACP_METHODS.worktreeAdd,
    list: REDSKILLS_ACP_METHODS.worktreeList,
  },
  add: { params: WORKTREE_ADD_PARAMS_SCHEMA, answer: WORKTREE_ADD_ANSWER_SCHEMA },
  list: { answer: WORKTREE_LIST_ANSWER_SCHEMA },
} as const;

/**
 * Validate `worktree_add` params against the published schema.
 *
 * `additionalProperties: false` is enforced rather than described, for the same
 * reason `go_dispatch` enforces it: a caller that smuggles a `checkout`, a
 * `lane` or a `project` past this validator is naming a daemon verdict, and a
 * silently ignored field reads to its author as a field that worked.
 */
export function worktreeAddParams(value: unknown): WorktreeAddParams {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw RequestError.invalidParams({}, "worktree_add requires an object naming a slug");
  }
  const unknownFields = Object.keys(value).filter((key) => !["slug", "branch", "base"].includes(key));
  if (unknownFields.length > 0) {
    throw RequestError.invalidParams(
      { unknown_fields: unknownFields },
      "worktree_add accepts no caller-named checkout, lane, Project or remote",
    );
  }
  const named = value as { readonly slug?: unknown; readonly branch?: unknown; readonly base?: unknown };
  const slug = typeof named.slug === "string" ? named.slug.trim().toLowerCase() : "";
  if (slug === "" || slug.length > WORKTREE_SLUG_MAX_LENGTH || !SLUG_PATTERN.test(slug)) {
    throw worktreeParamsRefusal(
      WORKTREE_REFUSAL_REASONS.slugUnusable,
      `worktree_add needs a slug of lowercase letters, digits, dot, dash or underscore, ` +
        `at most ${WORKTREE_SLUG_MAX_LENGTH} characters`,
    );
  }
  return {
    slug,
    ...optionalRef("branch", named.branch),
    ...optionalRef("base", named.base),
  };
}

function optionalRef(field: "branch" | "base", value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "string" || !refIsUsable(value)) {
    throw worktreeParamsRefusal(
      WORKTREE_REFUSAL_REASONS.refUnusable,
      `worktree_add refuses ${field} ${JSON.stringify(value)}: it is not a name git reads as a branch`,
    );
  }
  return { [field]: value };
}
