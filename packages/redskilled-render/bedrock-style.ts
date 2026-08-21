// bedrock-style — the themed render of the Statusline Bedrock.
//
// **It lives beside the tail's render because ONE process draws both halves.**
// ADR 0147 deleted the dev bundle that used to own the bedrock, and PR #4272
// pointed the host's statusline at the `redskilled` bundle. The daemon may not
// import a runtime (dependency-direction guard #4135), so the paint moved down
// to the render package the daemon already reaches; the semantic baseline it
// paints moved further down still, to `@reddb-io/shared`.
//
// **A paint transformation, not a re-render.** The plain bedrock
// (`@reddb-io/shared/statusline-bedrock.js`) stays the semantic baseline (ADR 0137 decision
// 2): this module calls the same block renderers and adds ONLY paint plus the
// `»` identity mark, which is why the invariant its test pins is
//
//   stripAnsi(renderStatuslineBedrockThemed(x)) === "» " + renderStatuslineBedrock(x)
//
// — themed and plain can never disagree about a fact, only about its colour.
//
// The paint is the shared role palette (`./palette.js`, ADR 0137): the project block is the one brand field, the model block recedes,
// and the KPI tail is a transparent-zone kv hierarchy. The render is
// self-closing (ends RESET), and every daemon tail line already closes itself,
// so the ` · ` seam `composeStatuslineLines` draws between the two segments
// renders in the terminal's own default — the seam is composition, not
// identity (ADR 0141 §5).
//
// The statusline lifecycle module stays 100% plain — the glyph is the truth and
// its tokens are the semantic baseline. {@link paintLifecycleTokens} paints the
// exact shapes it emits at the adapter's request; a painted daemon row passes
// through untouched.
//
// PURE (inputs → string). The colour DECISION (NO_COLOR) lives in the adapter —
// the daemon's `statusline-bedrock-host.ts` — never here.

import {
  BOLD,
  DIM,
  IDENTITY_BG,
  IDENTITY_INK,
  KEY,
  MODEL_BG,
  NOBG,
  NOBOLD,
  PAPER,
  RESET,
  SOFT,
  VAL,
} from "./palette.js";
import {
  renderBedrockProjectBlock,
  renderContextBlock,
  renderLocalDiffBlock,
  renderModelBlock,
  renderUsageBlock,
  type StatuslineBedrockInput,
} from "@reddb-io/shared/statusline-bedrock.js";

/** A plain inter-block space in the transparent zone. */
const SOFT_SPACE = `${SOFT} `;
/** The lifecycle's cached-tail suffix still owns its explicit boundaries. */
const SOFT_SEPARATOR = `${SOFT} · `;

/** Paint every `k=v` in a transparent-zone block: paper KEY, default-fg VALUE,
 * back to SOFT. Keys may open with a digit (`5h=`, `7d=`). */
function paintKeyValues(text: string): string {
  return text.replace(
    /(^|\s)([A-Za-z0-9][A-Za-z0-9/]*=)(\S+)/g,
    (_match, lead: string, key: string, value: string) => `${lead}${KEY}${key}${VAL}${value}${SOFT}`,
  );
}

/** The brand field over the project block: `»`, BOLD basename, branch and
 * version in the same ink — `neutral.500` has no contrast against
 * `brand.primary`, so nothing dims on the field. */
function paintProjectBlock(input: StatuslineBedrockInput): string {
  const block = renderBedrockProjectBlock(input.project);
  const basename = input.project.basename;
  const bold = block.startsWith(basename);
  const lead = bold ? basename : "";
  const rest = bold ? block.slice(basename.length) : block;
  return `${IDENTITY_BG}${IDENTITY_INK}» ${BOLD}${lead}${NOBOLD}${rest}${NOBG}`;
}

/**
 * The themed bedrock: brand field, receded model field, then the KPI tail in
 * the transparent-zone kv hierarchy. Content is the plain render's, block for
 * block and separator for separator; only paint and the `»` mark are added.
 */
export function renderStatuslineBedrockThemed(input: StatuslineBedrockInput): string {
  let line = paintProjectBlock(input);
  const model = renderModelBlock(input.claude);
  if (model !== null) line += `${SOFT_SPACE}${MODEL_BG}${PAPER}${model}${NOBG}`;
  const context = renderContextBlock(input.claude);
  if (context !== null) line += `${SOFT_SPACE}${KEY}ctx=${VAL}${context}`;
  const usage = renderUsageBlock(input.claude);
  if (usage !== null) line += `${SOFT_SPACE}${paintKeyValues(usage)}`;
  const localDiff = renderLocalDiffBlock(input.localDiff);
  // `loc=`'s value is the whole signed pair — `+A -R` with its space — so the
  // generic \S+ matcher would leave the removed half outside the VALUE tone.
  if (localDiff !== null) {
    line += `${SOFT_SPACE}${KEY}loc=${VAL}${localDiff.slice("loc=".length)}`;
  }
  return `${line}${RESET}`;
}

// The two plain shapes core/statusline-lifecycle.ts emits. The state vocabulary
// is deliberately NOT restated here: any `rsk=<token>` the lifecycle module
// mints inherits the paint, so a new state cannot render as a plain outlier.
const LIFECYCLE_TOKEN_LINE = /^rsk=[a-z-]+$/;
const LIFECYCLE_BADGE = /^(age=(\S+)|rsk=([a-z-]+)) · (.*)$/;

/** One painted lifecycle token: paper key, DIM value — recessed, because the
 * glyphs already carry the meaning and `red.500` stays spent on failure. */
function paintedToken(key: string, value: string): string {
  return `${KEY}${key}=${DIM}${value}`;
}

/**
 * Paint the lifecycle-owned shapes in a tail line; pass every other line
 * through untouched (a live daemon row arrives already painted). Handles the
 * two shapes `lifecycleTailLines` emits: a whole-line `rsk=<state>` token when
 * there is nothing to draw, and a LEADING `age=<t> · ` (or `rsk=<state> · `)
 * badge on a head that still carries its numbers.
 */
export function paintLifecycleTokens(line: string): string {
  if (LIFECYCLE_TOKEN_LINE.test(line)) {
    const state = line.slice("rsk=".length);
    return `${NOBG}${paintedToken("rsk", state)}${RESET}`;
  }
  const badge = LIFECYCLE_BADGE.exec(line);
  if (badge !== null) {
    const [, , age, state, head] = badge;
    const painted = age === undefined
      ? paintedToken("rsk", state!)
      : paintedToken("age", age);
    return `${NOBG}${painted}${SOFT_SEPARATOR}${head}${RESET}`;
  }
  return line;
}
