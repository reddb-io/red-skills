---
name: browser-review
working-mode: interactive
description: Open a generated HTML artifact for live human review — the human annotates an exact element and character range, the agent polls that feedback and iterates. A layout-audit gate blocks "done" on a broken render. Use when you want surgical element-level annotation instead of "screenshot + describe in prose", or need a ground-truth render check before declaring UI work done.
---

<what-to-do>

**Annotate the exact element, not a prose paraphrase.** This skill replaces "screenshot + guess" with a live CLI↔browser bridge: the human right-clicks the offending node, the bridge captures its selector and the selected character range, and you act on *that exact* target. The bridge is local — all state lives under `.red/browser-bridge/`, nothing leaves the machine. The engine is `@reddb-io/browser-bridge` (`packages/browser-bridge`).

**Run the loop in this order. Do not skip the gate.**

1. **Open** the artifact. Call `openArtifact("<file>.html")`. It writes `<file>.bridge.html` (the artifact plus an injected feedback SDK) and a session under `.red/browser-bridge/<id>/`. Start the bridge server (`createBridgeServer`) and tell the human to open the `.bridge.html` file.
2. **Poll** for annotations. Loop `pollAnnotations(root, id, cursor)`, advancing `cursor` by the returned `cursor` each time. Each annotation carries `selector`, an optional `textRange` (`{start, end, quote}`), and the human's `comment`. Act on the precise target; call `resolveAnnotation` when done.
3. **Gate** before "done". Collect a layout snapshot from the rendered DOM and call `assertLayoutClean(snapshot)`. It throws `LayoutAuditError` on horizontal overflow, clipped text, or overlapping text. **A render that fails the gate is not done** — fix it, re-snapshot, re-gate. Only a clean gate plus resolved annotations counts as finished.

**Three shapes of the same loop:**

- **frontend bug-report** — point at the broken element in a live render → a structured bug (selector + range + comment) that feeds `/report-bug`.
- **planning** — emit the plan as an HTML artifact → the human annotates the exact line to change, instead of editing a markdown plan file blind.
- **dev-loop** — build UI → the layout-audit gate blocks "done" on a broken render → the human annotates → iterate (pair with `/impeccable` / frontend-design).

**Keep artifacts portable — never hand-edit the augmented file.** ✅ Generate the artifact, then let `openArtifact` inject the SDK. ❌ Do not paste bridge markup into the source by hand, and do not add bridge-only styles. The injected SDK is additive and self-guarding: opened in a plain browser with no bridge running it stays inert, so `<file>.bridge.html` renders identically to the original. `stripBridgeSdk` recovers the byte-exact source.

**No source-repo names in committed content.** The capability is `red-browser` over the `browser-bridge` package; never reference the upstream repos this absorbs.

</what-to-do>

<supporting-info>

## State layout

```
.red/browser-bridge/<session-id>/
  session.json      # artifact path, augmented path, endpoint, status
  annotations.json  # append-only; the browser SDK POSTs, the agent polls
```

## Bridge API (`@reddb-io/browser-bridge`)

| Function | Use |
| -------- | --- |
| `openArtifact(htmlPath, opts?)` | Create the session, inject the SDK, write `<file>.bridge.html`. |
| `createBridgeServer({ root, port? })` | Start the loopback long-poll server (`/health`, `POST/GET /sessions/:id/annotations`). |
| `pollAnnotations(root, id, cursor)` | Read annotations newer than `cursor`; returns `{ annotations, cursor }`. |
| `recordAnnotation(root, id, input)` | Where the browser POST lands (selector + optional `textRange` + comment). |
| `resolveAnnotation(root, id, annId)` | Mark an annotation acted-on. |
| `assertLayoutClean(snapshot, opts?)` | The gate. Throws `LayoutAuditError` when the render is broken. |
| `auditLayout(snapshot, opts?)` | Non-throwing audit → `{ passed, findings }`. |

## Layout-audit findings

- `horizontal-overflow` — document or an element extends past the viewport width (the side-scroll bug).
- `clipped-text` — a text element's content is cut off by a hard clip (`overflow: hidden`/`clip`); scrollable overflow (`auto`/`scroll`) is **not** flagged.
- `text-overlap` — two text boxes collide without one nesting the other.

`auditLayout` takes `tolerancePx` (default 1) to absorb sub-pixel rounding and `minOverlapArea` (default 4 px²) for the overlap threshold.

## Status

Draft (in-progress). This is the artifact-annotation half of the browser-collaboration capability (PRD #928). The live-app CDP driver half builds on the same bridge in a later slice. Graduates out of `in-progress/` once the `red-browser` surface and the thin entry points in `/report-bug`, `/prototype`, `/impeccable`, and `/verify` are wired.

</supporting-info>
