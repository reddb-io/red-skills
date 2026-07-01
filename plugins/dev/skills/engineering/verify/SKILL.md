---
name: verify
description: "Verify that a code change does what it's supposed to by driving a live app with the CDP driver and checking ground-truth snapshots. Use when asked to verify a PR, confirm a fix works, test a change manually, or validate that a feature is visible/functional before closing an issue."
---

# Verify

<what-to-do>

**Ground-truth discipline: you cannot assert success without a fresh snapshot.** Every visible-state claim must be backed by a `red-browser snapshot` result taken *after* the change is live. A hallucinated "the button appeared" that no snapshot confirms is a failed verification.

## Steps

1. **Start the app.** Use whatever the project's dev command is (`pnpm dev`, `npm start`, etc.). Note the port.

2. **Open Chrome with CDP enabled.** In a separate terminal or background process:
   ```
   google-chrome --remote-debugging-port=9222 --no-first-run --no-default-browser-check http://localhost:<app-port>
   ```
   Or if Chrome is already open, confirm `curl -s http://localhost:9222/json/list` returns targets.

3. **Take a ground-truth snapshot.**
   ```
   red-browser snapshot --cdp http://localhost:9222 [--target <url-substring>]
   ```
   The command outputs JSON:
   - `snapshotId` — monotonically increasing; a higher ID means a newer snapshot.
   - `a11y` — the full accessibility tree, each node tagged with a stable `ref` integer.
   - `console` — console entries emitted since the driver connected.
   - `network` — network responses received since the driver connected.

4. **Verify against the snapshot.** Read the JSON output and confirm every claimed property:
   - "The Submit button is visible" → find a node with `role: "button"` and `name: "Submit"` in `a11y`.
   - "No console errors" → confirm `console` has no entries with `level: "error"`.
   - "The API call succeeded" → find the relevant URL in `network` with the expected `status`.

5. **Stale-ref rule.** If you reference a node's `ref` across two snapshots, verify it is still live by checking whether it appears in the latest snapshot. A `ref` absent from the newest snapshot is stale — take a new snapshot and locate the node again before asserting anything about it.

6. **Iterate.** If the snapshot does not match expectations, diagnose → fix → re-snapshot. Do not close the issue or declare success until a snapshot confirms the expected state.

## Hard rules

- ❌ Do **not** claim a UI element is present without a snapshot that contains it.
- ❌ Do **not** reuse a node `ref` from a snapshot taken before a page reload or navigation.
- ❌ Do **not** declare "LGTM" or "tests pass" as a substitute for a snapshot when the task is visual or interactive.
- ✅ Always paste the relevant excerpt from the snapshot JSON into your reasoning when asserting visible state.
- ✅ Take a new snapshot after every meaningful interaction (form submit, navigation, state change).

</what-to-do>

<supporting-info>

## `red-browser snapshot` reference

```
red-browser snapshot [--cdp <url>] [--target <url-substring>]
```

| Flag | Default | Description |
|---|---|---|
| `--cdp` | `http://localhost:9222` | Base URL of the Chrome DevTools endpoint |
| `--target` | *(first open tab)* | Substring to match against the target page URL |

### Output schema

```jsonc
{
  "snapshotId": 1,
  "a11y": [
    {
      "ref": 1,            // stable integer — use this to reference a node
      "role": "WebArea",
      "name": "My App",
      "description": "",   // optional
      "value": "",         // optional (input values, etc.)
      "children": [
        {
          "ref": 2,
          "role": "button",
          "name": "Submit",
          "children": []
        }
      ]
    }
  ],
  "console": [
    { "level": "error", "text": "Uncaught TypeError: ...", "timestamp": 1234567890 }
  ],
  "network": [
    { "url": "https://api.example.com/data", "method": "GET", "status": 200, "mimeType": "application/json", "timestamp": 1234567890 }
  ]
}
```

### A11y roles to look for

| Goal | Role(s) to match |
|---|---|
| Button | `button`, `menuitem` |
| Link | `link` |
| Text input | `textbox`, `searchbox`, `spinbutton` |
| Heading | `heading` |
| Image | `img` |
| Dialog / modal | `dialog`, `alertdialog` |
| List item | `listitem` |
| Checkbox / radio | `checkbox`, `radio` |
| Alert / toast | `alert`, `status` |

## Chrome launch flags

Minimal set for local verification:
```
google-chrome \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions \
  http://localhost:<port>
```

For headless runs (CI or no display):
```
google-chrome \
  --headless=new \
  --remote-debugging-port=9222 \
  --no-sandbox \
  http://localhost:<port>
```

Chromium works as a drop-in replacement; so does `microsoft-edge`.

## Anti-hallucination contract

The snapshot is the single source of truth for what the browser is actually rendering. Everything you say about the visible state of the app must be traceable to a node in the most recent `a11y` tree. If you cannot find the node, the element is either not rendered, not accessible, or behind an interaction you have not yet performed.

</supporting-info>
