import { runGh, type GhContext } from "./common.js";

/**
 * Both probes in this module opt OUT of quota backoff. They are read-only boot
 * prechecks that already classify a rate limit as transient and let boot proceed
 * (see `ghAuthTransientPattern`); waiting up to the 30-minute cap here would turn
 * a survivable blip into a boot stall. The mutations boot leads to keep the
 * default backoff.
 */
const NO_QUOTA_WAIT = { quota: "off" } as const;

export async function ghInstalled(ctx: GhContext): Promise<boolean> {
  const r = await runGh(ctx, ["--version"], NO_QUOTA_WAIT);
  return r.code !== 127;
}

/**
 * Definitive "no usable credential" signals in `gh auth status` output: the
 * token is absent or the host rejected it. ONLY these mean unauthenticated.
 */
const ghUnauthenticatedPattern =
  /not logged in|no GitHub hosts|no accounts? (are )?logged|authentication required|requires authentication|bad credentials|token .*(invalid|expired|revoked)|run.*gh auth login/i;

/**
 * Transient `gh auth status` failures that DON'T mean unauthenticated: gh
 * validates the configured token via a live API call, so a rate-limit / network
 * / 5xx blip makes `gh auth status` exit non-zero while the credential is still
 * present and valid. Treating these as "unauthenticated" is what bricked the
 * whole fleet's boot precheck during a GitHub rate-limit burst — every worker
 * respawn re-ran the precheck and died with a false "gh not authenticated".
 */
const ghAuthTransientPattern =
  /rate limit|api rate limit|abuse detection|secondary rate|timed? ?out|timeout|temporarily unavailable|service unavailable|could not connect|connection (reset|refused)|dial tcp|i\/o timeout|\b5\d\d\b|EOF|TLS handshake/i;

/**
 * True when `gh` holds a usable credential.
 *
 * `gh auth status` exits 0 when the token validates. A non-zero exit is NOT
 * automatically "unauthenticated": gh exits non-zero both on a real missing /
 * rejected token AND on a transient failure of the validation API call (rate
 * limit, network, 5xx) while a valid token is still configured. We discriminate
 * on the report text (gh writes it to stderr): a transient blip → true (token
 * present, just couldn't validate now — boot proceeds and the individual gh
 * calls degrade on their own `r.code !== 0` guards); a definitive
 * unauthenticated signal → false. An unrecognised non-zero stays conservative →
 * false.
 *
 * The transient pattern is tested BEFORE the unauthenticated one: a transient
 * report may itself carry an auth hint ("…try again later; run `gh auth login`
 * if this persists"), and a rate-limit / 5xx blip with a valid token configured
 * must NOT be misread as unauthenticated just because the hint matched. The
 * live-API failure is the stronger signal that the credential is present.
 */
export async function ghAuthenticated(ctx: GhContext): Promise<boolean> {
  const r = await runGh(ctx, ["auth", "status"], NO_QUOTA_WAIT);
  if (r.code === 0) return true;
  const report = `${r.stdout}\n${r.stderr}`;
  if (ghAuthTransientPattern.test(report)) return true;
  if (ghUnauthenticatedPattern.test(report)) return false;
  return false;
}
