/**
 * canonical-invocation — the ONE spelling of "run this binary" (issue #3071).
 *
 * A hint is read at exactly the moment the host is broken, so it must not assume
 * the host is working. `Run \`redskilled provision\`` fails that test twice: the
 * binary is on PATH only where an installer put a shim, and the hint that names
 * it is printed precisely when the daemon that shim would have installed is
 * absent — the instruction points at its own precondition (#2961).
 *
 * The npm direct-run form (ADR 0091) has neither problem: npm is the one
 * transport every host already has, and `-p <pkg>@<version>` pins what runs.
 *
 * **Why a function and not a string per call site.** The launch path, the
 * registration refusal, the provisioning audit and the UI empty states all
 * advise the same repair, and four hand-written spellings drift into four
 * different repairs. One namer means a version the caller knows rides the hint,
 * and a caller that knows nothing still emits a form that works.
 */
import { NPM_PACKAGE } from "./bundle-fetch.js";

/**
 * The version placeholder used when the caller knows no version.
 *
 * Deliberately a legible token rather than `latest`: an operator pasting it
 * unedited gets an error naming the thing they must supply, which beats silently
 * resolving to a version nobody chose.
 */
export const CANONICAL_VERSION_PLACEHOLDER = "<version>";

/** Every binary the npm package ships, as its bin-map name. */
export type ShippedBinary =
  | "red-skills-dev"
  | "red-skills-memory"
  | "red-skills-brain"
  | "red-skills-redskilled"
  | "red-skills-code-nav"
  | "red-skills-redskilled-mcp"
  | "red-skills-herdr";

/**
 * The canonical command line for `binary`, optionally carrying `args`. PURE.
 *
 * `version` is the pin the caller knows — its own build stamp, the plugin
 * manifest, the statusline's `vX.Y.Z`. Omitted (or blank) it falls back to the
 * placeholder, which is still a correct instruction, just one the reader has to
 * finish.
 */
export function canonicalInvocation(
  binary: ShippedBinary,
  args: readonly string[] = [],
  version?: string,
): string {
  const pin = version && version.trim().length > 0 ? version.trim() : CANONICAL_VERSION_PLACEHOLDER;
  return [`npx -y -p ${NPM_PACKAGE}@${pin}`, binary, ...args].join(" ");
}
