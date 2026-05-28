---
name: feedback-red-workflow-prefix
description: "All GitHub Actions workflows shipped by RedSkills must have filenames prefixed with `red-` (e.g. `red-issues-needs-triage.yml`, `red-upstream-watch.yml`)."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 26c34665-7482-4411-b76e-b02357147e09
---

All GitHub Actions workflow files authored by RedSkills (in this repo and in seed templates installed in consumer repos) must use the `red-` filename prefix.

**Why:** consistent namespace, easy to grep / audit which workflows belong to the RedSkills ecosystem vs the host project's own CI. Avoids collisions with workflows the user already has.

**How to apply:**
- New workflow files: name them `red-<topic>.yml` (e.g. `red-issues-needs-triage.yml`, `red-upstream-watch.yml`).
- When shipping a workflow as a template via a skill (e.g. `setup-redskills`), the template filename and the path it's copied to in the consumer repo both follow this convention.
- The job/workflow `name:` field inside the YAML doesn't have to start with `red-`, but the filename does.
- Applies retroactively too — flag any existing workflow without the prefix as a candidate to rename.
