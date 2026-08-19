/**
 * screen — the alternate-screen loop every view in this plugin runs inside.
 *
 * **The terminal is always given back.** A pane that exits leaving raw mode on,
 * the cursor hidden, or the alternate screen active hands the operator a shell
 * they cannot type into, and the failure looks like herdr's rather than this
 * plugin's. So teardown is registered against normal exit, both interrupts, and
 * an uncaught throw, and it is idempotent.
 *
 * **A frame is one write.** Lines are composed, joined, and written once with
 * the cursor parked at home — a render that wrote line by line would tear
 * visibly on a pane being resized while an agent floods the neighbouring one.
 */
import { BEL, ESC } from "./ansi.mjs";

const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const CURSOR_HOME = `${ESC}[H`;
const CLEAR_LINE = `${ESC}[K`;
const CLEAR_BELOW = `${ESC}[J`;

/** The keypress a byte sequence denotes, in the vocabulary a view switches on. PURE. */
export function decodeKey(data) {
  const raw = data.toString("utf8");
  switch (raw) {
    case "\u0003":
      return { name: "ctrl-c", raw };
    case "\u001b":
      return { name: "escape", raw };
    case "\r":
    case "\n":
      return { name: "enter", raw };
    case "\u001b[A":
      return { name: "up", raw };
    case "\u001b[B":
      return { name: "down", raw };
    case "\u001b[C":
      return { name: "right", raw };
    case "\u001b[D":
      return { name: "left", raw };
    case "\u001b[5~":
      return { name: "page-up", raw };
    case "\u001b[6~":
      return { name: "page-down", raw };
    case "\u001b[H":
    case "\u001b[1~":
      return { name: "home", raw };
    case "\u001b[F":
    case "\u001b[4~":
      return { name: "end", raw };
    case " ":
      return { name: "space", raw };
    case "\t":
      return { name: "tab", raw };
    default:
      return { name: raw, raw };
  }
}

/**
 * Run a view until it asks to stop.
 *
 * `render(size)` returns the lines of one frame. `onKey(key)` may return
 * `"quit"` to end the loop; anything else re-renders immediately, so a keypress
 * never waits out the refresh interval to be seen.
 */
export async function runScreen({ render, onKey, refreshMs = 2_000, onTick, title }) {
  const out = process.stdout;
  const input = process.stdin;
  let stopped = false;
  let restored = false;
  let timer = null;

  function size() {
    return { columns: out.columns || 80, rows: out.rows || 24 };
  }

  function paint() {
    if (stopped) return;
    const { columns, rows } = size();
    const lines = render({ columns, rows });
    const frame = lines.slice(0, rows).map((line) => `${line}${CLEAR_LINE}`).join("\r\n");
    out.write(`${CURSOR_HOME}${frame}\r\n${CLEAR_BELOW}`);
  }

  function restore() {
    if (restored) return;
    restored = true;
    if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(false);
    input.pause();
    out.write(`${CURSOR_SHOW}${ALT_OFF}`);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    restore();
  }

  if (title) out.write(`${ESC}]0;${title}${BEL}`);
  out.write(`${ALT_ON}${CURSOR_HIDE}`);
  if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(true);
  input.resume();

  process.on("exit", restore);
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  process.on("uncaughtException", (error) => {
    stop();
    process.stderr.write(`red-skills-herdr: ${error?.stack || error}\n`);
    process.exit(1);
  });

  out.on("resize", paint);

  const done = new Promise((resolve) => {
    input.on("data", async (data) => {
      const key = decodeKey(data);
      let verdict;
      try {
        verdict = await onKey(key);
      } catch (error) {
        process.stderr.write(`red-skills-herdr: ${error?.message ?? error}\n`);
      }
      if (verdict === "quit") {
        stop();
        resolve();
        return;
      }
      paint();
    });
  });

  if (onTick) await onTick();
  paint();
  timer = setInterval(async () => {
    if (stopped) return;
    if (onTick) {
      try {
        await onTick();
      } catch (error) {
        process.stderr.write(`red-skills-herdr: ${error?.message ?? error}\n`);
      }
    }
    paint();
  }, Math.max(250, refreshMs));

  await done;
}
