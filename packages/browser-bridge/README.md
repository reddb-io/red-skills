# @reddb-io/browser-bridge

The CLI↔browser annotation bridge plus a layout-audit gate for HTML artifacts — the
human+agent+browser triangle, with no cloud. State lives entirely under
`.red/browser-bridge/`.

This is the **artifact-annotation half** of the browser-collaboration capability
(PRD #928): the agent generates an HTML artifact (a plan, dashboard, or report), a
human points at an exact element and (optionally) a character range and sends
feedback, the agent polls that feedback back, and a layout-audit gate blocks "done"
on a visually broken render. The live-app CDP driver is a later slice on the same
proven bridge.

## Pieces

| Module             | Responsibility |
| ------------------ | -------------- |
| `layout-audit.ts`  | Pure gate over a layout snapshot — flags horizontal overflow, clipped text, and overlapping text. `assertLayoutClean` throws `LayoutAuditError` before "done". |
| `inject.ts`        | Injects a single, additive, self-guarding SDK `<script>` into the artifact. Round-trips back to the byte-identical original, so the file renders identically in a plain browser. |
| `session.ts`       | Filesystem session store — open an artifact, record annotations (element selector + character range), poll them with a cursor. |
| `server.ts`        | Thin `node:http` long-poll transport over the store. `dispatchBridgeRequest` is the pure, socket-free request mapper. |
| `annotation.ts`    | Annotation model + input validation. |

## Round-trip

```ts
import { openArtifact, recordAnnotation, pollAnnotations } from "@reddb-io/browser-bridge";

const session = openArtifact("plan.html");        // writes plan.bridge.html + session state
// (browser SDK POSTs this when the human right-clicks an element)
recordAnnotation(process.cwd(), session.id, {
  selector: "#plan > section:nth-of-type(2) > h2",
  textRange: { start: 0, end: 11, quote: "Quarter goal" },
  comment: "this heading overflows on mobile",
});
const { annotations } = pollAnnotations(process.cwd(), session.id, 0);
```

## Layout-audit gate

```ts
import { assertLayoutClean } from "@reddb-io/browser-bridge";

// snapshot is geometry the browser SDK reads from the rendered DOM
assertLayoutClean(snapshot); // throws LayoutAuditError when the render is broken
```

## Portability

The injected SDK adds no markup and no styles, probes the local bridge endpoint, and
stays inert when it is unreachable (e.g. opened from `file://` with no CLI running).
`stripBridgeSdk` recovers the exact original artifact. No source bytes are mutated.
