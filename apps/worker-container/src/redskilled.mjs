/**
 * The one shipped binary this lane reaches for, and the two forms it rides.
 *
 * **The container names a binary the repository ships.** It used to name the
 * dev CLI, which #4031 deleted with its 36-command router, so every run died at
 * command-not-found before it touched a queue (#4118). ADR 0147 rule 1 leaves
 * exactly one shipped binary in the execution chain, and the `bin` map of
 * `@reddb-io/red-skills` spells it {@link REDSKILLED_BINARY} — `redskilled` is
 * the daemon's name in prose, never a token in an argv.
 *
 * Two forms, and the default is the portable one:
 *
 *  - {@link canonicalRedskilledInvocation} — the ADR 0091 form,
 *    `npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled …`. It
 *    pins the version and works on a host that has installed nothing.
 *  - {@link pathRedskilledInvocation} — the bare binary, which is only ever a
 *    warm-cache optimization. This image installs the pinned package globally
 *    at build time, so it DECLARES the optimization with
 *    `RED_SKILLS_INVOCATION=path` instead of paying an npm resolve per birth.
 *
 * PURE — env in, argv out; nothing here spawns anything.
 */

/** The npm package whose `bin` map declares the binary. */
export const RED_SKILLS_PACKAGE = "@reddb-io/red-skills";

/** The shipped binary name, exactly as the `bin` map spells it. */
export const REDSKILLED_BINARY = "red-skills-redskilled";

/** What `RED_SKILLS_VERSION` means when the image was built without a pin. */
export const DEFAULT_RED_SKILLS_VERSION = "latest";

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** The version this container pins the daemon to. PURE. */
export function redSkillsVersion(env) {
  return trimmed(env?.RED_SKILLS_VERSION) || DEFAULT_RED_SKILLS_VERSION;
}

/** `npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled <args…>`. PURE. */
export function canonicalRedskilledInvocation(env, args = []) {
  return ["npx", "-y", "-p", `${RED_SKILLS_PACKAGE}@${redSkillsVersion(env)}`, REDSKILLED_BINARY, ...args];
}

/** The globally installed binary, for a host that already has the pin. PURE. */
export function pathRedskilledInvocation(args = []) {
  return [REDSKILLED_BINARY, ...args];
}

/**
 * The argv this container runs the daemon — and asks the daemon to run a
 * Worker — with. PURE.
 *
 * The choice is DECLARED by the environment rather than sniffed: a probe that
 * guessed from `PATH` would silently switch forms between the image and a bare
 * host, and a birth argv that means two different things is the one thing the
 * daemon's launch probe cannot warn about.
 */
export function redskilledInvocation(env, args = []) {
  return trimmed(env?.RED_SKILLS_INVOCATION).toLowerCase() === "path"
    ? pathRedskilledInvocation(args)
    : canonicalRedskilledInvocation(env, args);
}
