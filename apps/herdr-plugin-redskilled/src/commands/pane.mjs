/**
 * pane — the actions an operator binds a key to.
 *
 * A toggle is `close`, and `open` only when nothing was there to close. herdr
 * already knows whether this plugin holds a pane, so asking it is one round trip
 * and one source of truth; a toggle that tracked "is it open" in a state file of
 * its own would be a second answer that goes stale the first time an operator
 * closes the pane by hand.
 */
import { closePluginPane, focusPluginPane, invocationCwd, openPluginPane } from "../herdr.mjs";

/** Which manifest entrypoint serves this platform. PURE. */
export function entrypointFor(name, platform = process.platform) {
  return platform === "win32" ? `${name}-windows` : name;
}

export async function runPane({ action, entrypoint = "dashboard", flags = {} }) {
  const id = entrypointFor(entrypoint);
  // Never `process.cwd()`: an action runs with the PLUGIN directory as its cwd,
  // so passing it would open every pane against this checkout and make `local`
  // mode report the plugin as the project. An unknown cwd is left unstated —
  // herdr's own default is a better answer than this process can compute.
  const cwd = flags.cwd ?? (await invocationCwd());
  const options = {
    entrypoint: id,
    placement: flags.placement,
    direction: flags.direction,
    ...(cwd ? { cwd } : {}),
    focus: flags.focus !== false,
    paneEnv: flags.worker ? { RED_SKILLS_WORKER: flags.worker } : {},
  };

  switch (action) {
    case "open": {
      const opened = await openPluginPane(options);
      if (!opened.ok) {
        process.stderr.write(`red-skills-herdr: could not open the ${id} pane: ${opened.stderr || opened.error?.message}\n`);
        return 1;
      }
      process.stdout.write(opened.stdout);
      return 0;
    }
    case "close": {
      const closed = await closePluginPane({ entrypoint: id });
      if (!closed.ok) {
        process.stderr.write(`red-skills-herdr: no ${id} pane was open\n`);
        return 1;
      }
      process.stdout.write(closed.stdout);
      return 0;
    }
    case "focus": {
      const focused = await focusPluginPane({ entrypoint: id });
      if (focused.ok) {
        process.stdout.write(focused.stdout);
        return 0;
      }
      return await runPane({ action: "open", entrypoint, flags });
    }
    case "toggle": {
      const closed = await closePluginPane({ entrypoint: id });
      if (closed.ok) {
        process.stdout.write(closed.stdout);
        return 0;
      }
      return await runPane({ action: "open", entrypoint, flags });
    }
    default:
      process.stderr.write(`red-skills-herdr: unknown pane action ${JSON.stringify(action)}\n`);
      return 2;
  }
}
