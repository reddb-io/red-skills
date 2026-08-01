/**
 * status — one read, printed or raised as a notification.
 *
 * The line comes from the daemon's own `statusline-string` op, never from this
 * plugin's rendering of the payload. ADR 0130 rule 10 makes the string a pure
 * function of the payload precisely so no surface has to reimplement it, and a
 * plugin that drew its own line would be the drift that pair of ops exists to
 * prevent. What travels over the socket is taste already decided here — mode,
 * width, verbosity — because the daemon must never learn what a config file is.
 */
import { createRedskilledClient, readRedskilledSnapshot } from "../redskilled/client.mjs";
import { resolveRedskilledPaths } from "../redskilled/paths.mjs";
import { resolveProjectLabel } from "../redskilled/project-identity.mjs";
import { notify } from "../herdr.mjs";

export async function runStatus({ config, flags = {} }) {
  const socket = resolveRedskilledPaths({ socketPath: flags.socket ?? config.socketPath });
  const client = createRedskilledClient({ socketPath: socket.socketPath, timeoutMs: config.timeoutMs });
  const mode = flags.mode ?? config.mode;
  const sessionProject = mode === "local" ? (await resolveProjectLabel(process.cwd()).catch(() => null)) ?? undefined : undefined;

  let render = null;
  let failure = null;
  try {
    render = await client.statuslineString(sessionProject, {
      mode,
      verbose: flags.verbose ?? false,
      ...(flags.maxWidth ? { max_width: flags.maxWidth } : {}),
    });
  } catch (error) {
    failure = error;
  }

  if (flags.json) {
    const snapshot = await readRedskilledSnapshot(client, { sessionProject });
    process.stdout.write(`${JSON.stringify({ socket: socket.socketPath, render, snapshot }, null, 2)}\n`);
    return failure ? 1 : 0;
  }

  const line = render?.line ?? `redskilled: ${failure?.message ?? "no host answered"}`;
  const lines = render?.lines?.length ? render.lines : [line];

  if (flags.notify) {
    await notify("redskilled", {
      body: lines.join(" · "),
      position: config.notifications.position,
      sound: config.notifications.sound,
    });
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return failure ? 1 : 0;
}
