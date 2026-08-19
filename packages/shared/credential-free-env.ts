// credential-free-env — the one list of environment names a disposable process
// may never inherit (ADR 0144 §3, ADR 0148).
//
// Two processes have to strip the same names: the daemon strips them when it
// births a Worker, and the Worker strips them again when it births the child
// coding Agent that runs the model. Two hand-kept lists is one list that goes
// stale — a name added where the Worker is born and forgotten where the model
// is born re-opens the seam at the only hop that actually runs untrusted output.
//
// What this list is NOT is containment. It is the belt: the braces are that no
// credential exists in the daemon's Worker environment at all, and that the
// Worker's terminal policy refuses the commands that would want one.

/**
 * True when the name carries GitHub or Git authentication, in value or in door.
 *
 * Both halves matter. A token is a value a child can read; `SSH_AUTH_SOCK` and
 * the askpass hooks carry no secret and still authenticate, which is why a
 * value-only sweep leaves a working push behind.
 */
export function isCredentialEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  if (["SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND"].includes(normalized)) {
    return true;
  }
  if (normalized === "REDSKILLED_HOST_TOKEN") return true;
  if (/^(?:GH|GITHUB)(?:_[A-Z0-9]+)*_(?:TOKEN|SECRET|KEY|APP_ID|INSTALLATION)$/.test(normalized)) return true;
  if (/^RED_GITHUB_(?:APP_ID|APP_INSTALLATION|APP_KEY)$/.test(normalized)) return true;
  // A daemon-side authenticated git invocation may use these transiently. No
  // inherited git config is allowed to become a disposable process's
  // authentication path.
  return /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(normalized);
}

/** The same environment minus every credential name, and minus every unset value. */
export function credentialFreeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value == null || isCredentialEnvironmentName(name)) continue;
    kept[name] = value;
  }
  return kept;
}
