---
name: wizard
description: Generate an interactive Bash wizard for steps only a human can perform. Use for credentials, CI secrets, third-party dashboards, provisioning, migrations, or cutovers that require human action.
---

# Wizard

A **wizard** is a Bash script that guides one human through a manual procedure.
It opens the correct pages, explains each action, captures pasted values, writes
`.env` entries and GitHub secrets, and reports progress.

The reusable interface lives in [template.sh](template.sh). The library above
the `STAGES` marker is identical in every wizard. Author only the stages below
that marker.

<what-to-do>

## 1. Scope The Human Procedure

**Read before asking** — inspect `.env*`, README files, service configuration,
compose files, and `.github/workflows/*` for every `secrets.*` and `vars.*`
reference. For a migration, inspect the current state, target state, and each
irreversible action between them.

Show the user the ordered stages and the values each stage produces. Ask them to
confirm, add, remove, or reorder stages.

Done when every stage names (1) where the human gets each value, (2) where the
wizard writes it, and (3) whether the value is secret.

## 2. Map Each Stage

**Trace the human journey** — name the page, control, action, result, and target
variable. Verify unfamiliar third-party interfaces in current official docs.
Ask the user when the route cannot be verified.

Done when a person unfamiliar with the service can follow every instruction.

## 3. Author Below The Marker

**Copy the template intact** — use `.red/tmp/scratch/<slug>/wizard.sh` for a
one-run wizard or `scripts/setup-<slug>.sh` when the user wants a maintained
setup path. Replace the example below `STAGES`; leave the library above it
byte-for-byte unchanged.

Use one `stage` per focused task. Use `say`, `step`, `open_url`, `ask`,
`ask_secret`, `write_env`, `set_secret`, `set_var`, `pause`, and `confirm` from
the template. Open the page before asking for its value. Use hidden input for a
secret. Persist every retained value. Send only CI inputs to GitHub. Put a
`confirm` immediately before an irreversible action. Set `TOTAL_STAGES` and
`TOTAL_MINUTES` from the authored stages.

Done when every scoped value is captured once and lands at its confirmed target.

## 4. Verify And Hand Off

**Check the script statically** — run `bash -n <script-path>` and run
`shellcheck <script-path>` when ShellCheck is available. Make a maintained
wizard executable. Trace every captured value to its write, and match each
`set_secret` name to the corresponding workflow `secrets.*` reference.

Hand the user `bash <script-path>`. Leave the interactive run to the human; it
opens browsers and waits for input. Link a maintained wizard from the owning
README.

Done when syntax passes and the user has one explicit Bash command to start it.

</what-to-do>

<supporting-info>

## Placement

Wizards are ephemeral by default. Put disposable output in the named
`.red/tmp/scratch/` lane and delete it after use. Commit a wizard only when the
procedure is a repeatable project setup path.

## Template Boundary

Treat everything above `STAGES` in [template.sh](template.sh) as vendored
library code. Procedure authors edit only totals and stages below the marker.

</supporting-info>
