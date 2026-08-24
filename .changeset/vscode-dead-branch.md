---
"vscode-extension-red-skills": patch
---

The dashboard view's unreachable dead branch ("this daemon does not serve statusline-dashboard" — false by construction since the dashboard is rendered locally from the same payload read) is deleted, and HostSnapshot becomes a discriminated union so the state is unrepresentable.
