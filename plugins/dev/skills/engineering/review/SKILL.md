---
name: review
description: Review a generated HTML artifact (plan, dashboard, or prototype) in the browser — opens the file via the annotation bridge, runs the layout-audit gate, long-polls for surgical human feedback (element + character range), and feeds the annotation back so the agent can iterate. Use when you have an HTML artifact ready for human review, want to replace the "screenshot + describe" loop with precise element-level annotations, or need to verify a rendered plan end-to-end.
argument-hint: "<html-file>"
---

# HTML Artifact Review

**Open, audit, annotate, iterate — no screenshots, no prose descriptions.**

The annotation bridge serves the HTML artifact locally with the annotation and layout-audit SDKs injected, runs the layout-audit gate before collecting any feedback, and long-polls for a surgical human annotation (element + character range). The annotation is the spec; the agent corrects and iterates until the human declares done.

<what-to-do>

## Step 1 — Resolve the artifact

Accept the HTML file path as the argument (`/review <html-file>`). If no path is given, ask for it. Confirm the file exists and is readable before proceeding.

## Step 2 — Open the annotation bridge

Run the `red-browser` CLI against the artifact:

```bash
node --import tsx apps/red-browser/src/cli.ts annotate "<html-file>"
```

The bridge:
1. Injects the annotation and layout-audit SDKs into the artifact.
2. Starts a local HTTP server and prints the URL to stderr.
3. **Runs the layout-audit gate** on page load — exits with code 2 and lists all violations if the layout is broken. Stop here if the audit fails: fix the violations, regenerate the artifact, and re-run.
4. Long-polls until the human posts an annotation (mouseup text selection), then prints the annotation as JSON on stdout.

Default annotation timeout: 60 seconds. For longer sessions pass `--timeout <ms>`:

```bash
node --import tsx apps/red-browser/src/cli.ts annotate "<html-file>" --timeout 300000
```

## Step 3 — Interpret the annotation

Parse the JSON output. The key fields:

| Field | Meaning |
|---|---|
| `element.xpath` | Exact DOM path of the selected element |
| `element.tagName` + `element.id` | Human-readable element identifier |
| `charRange.start` / `end` / `text` | Selected text span within the element |

The annotation is a **surgical pointer** — act on the identified element and character range, not on the page as a whole. Do not infer a broader change from a narrow selection without confirming with the human.

## Step 4 — Correct and iterate

Apply the correction to the source that generated the artifact. Regenerate the HTML. Go back to Step 2. Repeat until the human stops annotating or explicitly declares done.

## Hard rules

- ❌ Do **not** skip the layout-audit gate (`--skip-audit`). The gate is the contract between generation and review; a broken render produces meaningless annotations.
- ❌ Do **not** declare done if the bridge exits with code 2 (layout violation). Fix the violations first.
- ❌ Do **not** widen the correction scope beyond the annotation's element and character range without explicit human agreement.
- ✅ Feed the full annotation JSON (element + charRange) into your correction reasoning before proposing a fix.
- ✅ One annotation per iteration. The human controls the pace.

</what-to-do>

<supporting-info>

## Why annotations replace screenshots

"The top-right section" names three different elements depending on the reader. An annotation captures the DOM xpath and character range — the correction target is unambiguous. Overflow/cutoff/overlap violations are caught by the layout-audit gate before the human sees the artifact, so feedback is never collected on a broken render.

## Bridge endpoints (injected SDKs call these — agent code never calls them directly)

| Endpoint | Direction | Purpose |
|---|---|---|
| `GET /` | bridge → browser | Serves the HTML artifact with SDKs injected |
| `POST /api/layout-audit-result` | browser → bridge | Audit SDK posts layout violations on page load |
| `POST /api/annotate` | browser → bridge | Annotation SDK posts element + char range on mouseup |

## Layout-audit violation types

| Type | Trigger |
|---|---|
| `overflow` | Element `scrollWidth > clientWidth` |
| `cutoff` | Content clipped by parent overflow boundary |
| `overlap` | Two elements' bounding rects intersect unexpectedly |

All violations must be zero before the bridge collects any annotation.

## Annotation output shape

```jsonc
{
  "element": {
    "tagName": "P",
    "id": "summary",
    "className": "lead",
    "xpath": "/html/body/section[1]/p[@id='summary']"
  },
  "charRange": {
    "start": 12,
    "end": 28,
    "text": "the second phase"
  },
  "timestamp": "2026-06-30T19:00:00.000Z"
}
```

</supporting-info>
