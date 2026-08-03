# @reddb-io/redskilled-render

One render implementation, outside the daemon, drawn at parameterized densities.
ADR 0132 decisions 1, 2 and 9; issue #3096.

## Why it exists

ADR 0130 rule 10 moved rendering into the `redskilled` daemon so that "the string
is a pure function of the payload" would keep surfaces from drifting. What that
bought was a statusline **poorer** than the one it replaced —

```
reddb-io/red-skills 2w 14.4M v3.3.9
```

— while the documented format carries runner, model, effort, phase, elapsed,
diffstat, tokens and vitals. Nothing regressed by accident: rule 3 forbids the
daemon castle semantics, and one rendered string cannot serve a one-line
statusline and a full TUI at once. The impoverished line was the designed
consequence of two rules meeting.

**The no-drift guarantee is one implementation, not one string.** This package is
that implementation. Four surfaces at four densities cannot share a string, and
they must not each own a layout.

## What it is

- **Stateless, and it opens no transport.** A pure function from one decoded
  payload to one drawn surface. Nothing here reads a clock, a directory, an
  environment variable or a file descriptor — which is why a fixture payload
  renders byte-identically to a live one, and why that claim is a test rather
  than a comment.
- **Encoding-agnostic inbound.** `decodeRedskilledPayload` accepts JSON, JSONL,
  TOON and TOONL, matching the decoder that already sniffs JSON-or-TOON. The
  repo's TOON mandate governs **writers** and is unchanged: what a reader
  tolerates and what a writer must emit are different contracts.
- **Three densities, composed rather than duplicated.** The degradation ladder,
  the Worker selection, the project-match verdict and the marks are shared, so a
  line and a table standing in the same directory describe the same machine by
  construction.

| density | what it draws | who asks for it |
| --- | --- | --- |
| `line` | one row, degrading workers → projects → host | the `statusLine` shell command |
| `panel` | a head plus a few rows; its first row **is** the line | a tooltip, a sidebar, a notification body |
| `dashboard` | the aligned table, the header, the death receipts | the editor panel, the terminal pane |

## Using it

```ts
import { renderRedskilled } from "@reddb-io/redskilled-render";

const drawn = renderRedskilled(payloadTextOrValue, {
  density: "panel",
  options: { project: "acme/widgets", maxWidth: 96, maxRows: 6 },
});
process.stdout.write(`${drawn.lines.join("\n")}\n`);
```

Each density is also exported on its own (`renderRedskilledStatusline`,
`renderRedskilledPanel`, `renderRedskilledDashboard`) for a caller whose height is
fixed at compile time. `renderRedskilled` exists for the callers whose height is
configuration — a pane an operator resizes, a tooltip that expands — because
choosing between three imports at run time is how a fourth layout gets written.

## The inbound contract

`payload.ts` declares the wire document this module reads, on the **reading**
side, and names only the fields a layout draws. One daemon serves checkouts
pinned to different bundle versions (ADR 0130 rule 3), so a renderer that
demanded the daemon's whole internal record would blank a pane over a field it
never prints. `apps/redskilled/tests/render-contract.test.ts` is the ratchet: the
daemon's own `RedskilledStatuslinePayload` is assigned to
`RedskilledRenderPayload` there, so a field that changes shape fails to compile
rather than failing to draw.

## Who draws through it

- **The statusline** — `redskilled statusline` reads the socket and renders here
  (ADR 0132 decision 9: a `statusLine` entry is a shell command, not an MCP
  client, so routing the tick through a server would mean a handshake per tick
  and a blank line whenever the server is not up).
- **The VS Code extension** — one `statusline-payload` read per frame, drawn
  here. It used to spend a second round trip on `statusline-dashboard` to receive
  text it could compute from bytes it already held.
- **The terminal dashboard and the herdr plugin** — through the daemon's
  `statusline-string` and `statusline-dashboard` ops, which are now one call of
  this module. Those ops stay because a pinned older plugin still asks for them;
  the layout behind them is no longer the daemon's.

## Withheld is not missing

The daemon serves the skeleton — Workers, projects, budget — on every response,
and the count-scaling extras (`logs`, `vitals`, `display`) on request. A Worker
whose vitals nobody asked for carries the same `rss_bytes: null` a Worker nobody
measured carries, so the payload's `withheld` array is what tells a consumer a
cheap read from a stopped sampler. A response that withheld nothing omits the
field entirely.
