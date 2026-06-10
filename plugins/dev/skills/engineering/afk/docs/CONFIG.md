# Configuration & Hooks

Scalar settings live in `.red/config.yaml` under `afk:` with matching `RED_AFK_*` env overrides (env wins). Lifecycle hooks are ordered lists of shell commands under `afk.hooks` with fixed lifecycle points and a single interceptor contract (input: JSON context on stdin; output: empty or mutated JSON; exit code: 0 continues, non-zero routes per hook policy). Built-in defaults run first, user hooks after, in declaration order. Disable a built-in with `afk.hooks.defaults.<name>: false`.

Shipped built-ins: `cargo`, `gradle`, `heartbeat`, `envelope`, `validation`. See `CHANGES.md` for full configuration schema and examples.
