/**
 * herdr — this plugin's side of the herdr CLI.
 *
 * `HERDR_BIN_PATH` is preferred over a bare `herdr` on PATH for the reason the
 * plugin docs give it: a pane may run with a PATH the operator never arranged,
 * and a notification that silently did not fire is worse than one that did not
 * exist. A failure here is reported and never thrown into a render loop.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The herdr binary this plugin should call. */
export function herdrBin(env = process.env) {
  return env.HERDR_BIN_PATH || "herdr";
}

/** True when this process is running inside a herdr-managed pane. */
export function insideHerdr(env = process.env) {
  return env.HERDR_ENV === "1";
}

/** The plugin id herdr registered us under, with the manifest's value as floor. */
export function pluginId(env = process.env) {
  return env.HERDR_PLUGIN_ID || "reddb-io.red-skills";
}

/** Run one herdr subcommand. Returns `{ ok, stdout, stderr }`, never throws. */
export async function herdr(args, { env = process.env, timeoutMs = 5_000 } = {}) {
  try {
    const { stdout, stderr } = await run(herdrBin(env), args, { timeout: timeoutMs, env });
    return { ok: true, stdout, stderr, error: null };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? "", error };
  }
}

/** Run one herdr subcommand and parse its JSON answer; `null` when it gave none. */
export async function herdrJson(args, options) {
  const result = await herdr(args, options);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Show a herdr notification.
 *
 * The body is trimmed to something a corner of the screen can hold: a
 * notification is a pointer to the dashboard, never a replacement for it.
 */
export async function notify(title, { body, position, sound, env = process.env } = {}) {
  const args = ["notification", "show", title];
  if (body) args.push("--body", body.length > 240 ? `${body.slice(0, 237)}...` : body);
  if (position) args.push("--position", position);
  if (sound) args.push("--sound", sound);
  return await herdr(args, { env });
}

/** Open one of this plugin's panes. */
export async function openPluginPane({
  entrypoint,
  placement,
  direction,
  cwd,
  focus = true,
  paneEnv = {},
  env = process.env,
} = {}) {
  const args = ["plugin", "pane", "open", "--plugin", pluginId(env), "--entrypoint", entrypoint];
  if (placement) args.push("--placement", placement);
  if (direction) args.push("--direction", direction);
  if (cwd) args.push("--cwd", cwd);
  args.push(focus ? "--focus" : "--no-focus");
  for (const [key, value] of Object.entries(paneEnv)) {
    if (value != null) args.push("--env", `${key}=${value}`);
  }
  return await herdr(args, { env });
}

/** Close one of this plugin's panes. */
export async function closePluginPane({ entrypoint, env = process.env } = {}) {
  return await herdr(["plugin", "pane", "close", "--plugin", pluginId(env), "--entrypoint", entrypoint], { env });
}

/** Focus one of this plugin's panes; the answer says whether one was open. */
export async function focusPluginPane({ entrypoint, env = process.env } = {}) {
  return await herdr(["plugin", "pane", "focus", "--plugin", pluginId(env), "--entrypoint", entrypoint], { env });
}

/** The invocation context herdr handed this command, or `{}` when it handed none. */
export function pluginContext(env = process.env) {
  const raw = env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** The first cwd any of these context shapes carries. PURE. */
export function cwdFromContext(context) {
  const candidates = [
    context?.pane?.cwd,
    context?.pane?.foreground_cwd,
    context?.focused_pane?.cwd,
    context?.cwd,
    context?.worktree?.path,
    context?.workspace?.cwd,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim() !== "") ?? null;
}

/**
 * The directory the operator invoked this from — never this process's own.
 *
 * The docs are explicit: "Runtime commands run with the plugin directory as
 * their working directory." So `process.cwd()` inside an action is the plugin
 * checkout, and a pane opened with it would report the PLUGIN as the local
 * project on every machine. The operator's directory has to be asked for: the
 * invocation context first, then the calling pane, and `null` rather than a
 * guess — herdr picks a better default than this process can.
 */
export async function invocationCwd({ env = process.env } = {}) {
  const fromContext = cwdFromContext(pluginContext(env));
  if (fromContext) return fromContext;

  const paneId = env.HERDR_PANE_ID;
  if (!paneId) return null;
  const answer = await herdrJson(["pane", "current", "--pane", paneId], { env });
  const pane = answer?.result?.pane ?? answer?.pane;
  const cwd = pane?.foreground_cwd || pane?.cwd;
  return typeof cwd === "string" && cwd.trim() !== "" ? cwd : null;
}
