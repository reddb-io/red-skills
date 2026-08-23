// statusline-main — the lean entry the prompt host runs on EVERY render.
//
// The statusline used to be a subcommand of the full daemon bundle, which made
// each prompt render pay the whole daemon's import-time initialization —
// measured at ~1.2s of module evaluation (schema construction and module init;
// node itself boots in ~70ms) before a single statusline line ran. A status
// producer that costs a second per keystroke-adjacent render is a tax on every
// session on the machine, so the statusline ships as its OWN bundle: same
// command module, same render, none of the daemon's import graph.
//
// The full bundle keeps its `statusline` subcommand — one command surface, two
// carriers — and the published shell prefers this bundle when the daemon has
// stabilized one, falling back to the full bundle on hosts that predate it.
import { runStatusline } from "./statusline-command.js";

const invokedDirectly = process.argv[1] != null &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  // The host may invoke `<bundle> statusline` (the full bundle's spelling) or
  // bare `<bundle>`; both reach the one command.
  const argv = process.argv.slice(2);
  runStatusline(argv[0] === "statusline" ? argv.slice(1) : argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`statusline: ${err instanceof Error ? err.message : String(err)}\n`);
      // The statusline contract: always exit 0 — an outage must not render as
      // a failed prompt hook.
      process.exitCode = 0;
    },
  );
}
