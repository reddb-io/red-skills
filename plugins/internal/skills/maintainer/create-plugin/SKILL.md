---
name: create-plugin
working-mode: interactive
description: Use when a RedSkills maintainer needs to scaffold a new repository plugin that is born compliant with the marketplace, skill, README, CHANGES, and structural-smoke contracts.
disable-model-invocation: true
---

# create-plugin

**Scaffold the plugin contract before changing the contract.** Any marketplace,
skill-body, README, CHANGES, or smoke-script requirement change must update this
scaffolder first, then the rest of the repo can follow from generated output.

<what-to-do>

Run the scaffolder from the RedSkills repository root:

```bash
bash plugins/internal/skills/maintainer/create-plugin/scripts/create-plugin.sh <plugin-name>
```

Use `--root <repo-root>` when operating on a copied fixture or another checkout:

```bash
bash plugins/internal/skills/maintainer/create-plugin/scripts/create-plugin.sh --root /tmp/red-skills-fixture acme-tools
```

The command creates:

- `plugins/<plugin-name>/.claude-plugin/plugin.json`
- `plugins/<plugin-name>/.codex-plugin/plugin.json`
- `plugins/<plugin-name>/skills/core/<seed-skill>/SKILL.md`
- `plugins/<plugin-name>/scripts/structural-smoke.sh`
- `plugins/<plugin-name>/README.md`
- `plugins/<plugin-name>/CHANGES.md`

It also appends matching entries to `.claude-plugin/marketplace.json`,
`.agents/plugins/marketplace.json`, and the root `README.md`.

After scaffolding, run the printed validation commands. They are the contract for
generated plugins: marketplace validation, frontmatter audit, and the generated
plugin's own structural smoke script.

</what-to-do>

<supporting-info>

The seed `SKILL.md` deliberately follows the two-section body convention:
`<what-to-do>` carries executable steps and `<supporting-info>` carries context.
Its first content sentence uses a bold imperative lead, and its frontmatter
description includes a concrete `Use when` trigger so it passes both the
frontmatter audit and the report-only body lint.

The generated `CHANGES.md` starts with `status: added` and `upstream: none` so
new plugins have a provenance stub before they accumulate inherited skills.

</supporting-info>
