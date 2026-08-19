---
name: bootstrap
working-mode: interactive
description: Placeholder maintainer-only internal skill. Use to confirm the internal plugin installed and that the current repo explicitly opted in with plugins.internal.enabled.
disable-model-invocation: true
---

# internal bootstrap

Confirms the maintainer-only `internal` plugin is installed and checks the ADR
0067 activation gate. Read-only: do not create or edit `.red/`.

<what-to-do>

Run this check from the current working directory:

```bash
node -e '
const { existsSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
let dir = process.cwd();
let config = null;
for (let i = 0; i < 16; i++) {
  const candidate = join(dir, ".red", "config.yaml");
  if (existsSync(candidate)) {
    config = candidate;
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
if (!config) {
  console.log("internal plugin installed; disabled (no .red/config.yaml)");
  process.exit(0);
}
const text = readFileSync(config, "utf8");
const lines = text.split(/\r?\n/);
let inInternal = false;
let enabled = false;
for (const line of lines) {
  if (/^  internal:\s*$/.test(line)) {
    inInternal = true;
    continue;
  }
  if (/^  \S[^:]*:/.test(line)) inInternal = false;
  if (inInternal && /^    enabled: true(\s+#.*)?$/.test(line)) enabled = true;
}
console.log(enabled
  ? `internal plugin installed and enabled by ${config}`
  : `internal plugin installed; disabled by ${config}`);
'
```

Report the printed line. If disabled, stop; do not create or edit `.red/`.

</what-to-do>
