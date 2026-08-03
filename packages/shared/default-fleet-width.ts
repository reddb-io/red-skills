// default-fleet-width — how many Workers a project registers for when nobody says.
//
// ADR 0132 decision 7. **The value is not the decision; the equality is.**
//
// Before this module the number lived in three places that disagreed: the MCP
// `project_start` schema defaulted to `2`, `CONFIG_DEFAULTS` carried `"2"`, the
// configuration documentation carried no width row at all, and the maintainer's
// intent was `1`. Three surfaces announcing different numbers are three
// defaults, and the drift is invisible until somebody counts running Workers.
//
// **One is the floor a maintainer can reason about.** A second Worker doubles
// GitHub polling against a budget metered per token — measured, two Workers
// spend ~2200 GraphQL points/hour of a 5000/hour window — and doubles memory
// against a host ceiling every Worker is already granted in full (#3080). That
// is a decision worth making deliberately rather than inheriting.
//
// A project that wants more says so in `plugins.dev.afk.target`; the daemon's
// host-scoped ceiling bounds it from above, because width is machine budget
// rather than project preference.
//
// PURE.

/** Workers a project registers for when nothing states a number. */
export const DEFAULT_FLEET_WIDTH = 1;

/** The config key a project states its own width under. */
export const FLEET_WIDTH_CONFIG_KEY = "afk.fleet.target";

/**
 * The default as `CONFIG_DEFAULTS` spells it — a string, like every entry there.
 *
 * Derived rather than written twice: a second literal is how the three numbers
 * came to disagree in the first place.
 */
export const DEFAULT_FLEET_WIDTH_CONFIG = String(DEFAULT_FLEET_WIDTH);
