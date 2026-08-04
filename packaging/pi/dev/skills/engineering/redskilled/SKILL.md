---
name: redskilled
description: Operates the per-machine redskilled daemon through its published status, provisioning, policy, and lifecycle surfaces. Use when the operator needs to inspect, provision, configure, restart, or confirm the host-scoped execution daemon.
disable-model-invocation: true
---

# Operate redskilled

Treat `redskilled` as the per-machine process authority: it owns Worker birth, death, limits, and placement across every project on the host.

<what-to-do>

1. **Read status before changing it** — run both read surfaces:

   ```bash
   npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision --check
   npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled host-state
   ```

   The provisioning audit says whether the daemon answers and names its socket.
   `host-state` says the running `daemon_version`, standing `registrations`, live
   `workers`, and the resolved `ceiling`. Read `worker_source`, `memory_source`,
   and `validation_source` beside the values; each is `flag`, `environment`,
   `home-config`, or `derived-default`. If `host-state` cannot contact a daemon,
   continue to provisioning rather than treating an empty machine as healthy.

2. **Provision through the one owner** — on a fresh machine, run:

   ```bash
   npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision --workspace host
   ```

   This calls `provisionRedskilledHome`, the only authority allowed to create
   `~/.red/redskilled/`, creates the initial `~/.red/config.yaml` template when
   absent, starts the daemon through ordinary client auto-spawn, and prints the
   audit. Never replace this step with a bare `mkdir ~/.red` — call the owner.

3. **Configure the machine policy** — edit the existing home file at
   `~/.red/config.yaml`, preserving unrelated operator settings, and set the
   required values under the exact `plugins.dev.redskilled` mapping:

   ```yaml
   plugins:
     dev:
       redskilled:
         worker_ceiling: 6
         memory_ceiling: 8G
         validation_ceiling: 2
         idle_ms: 300000
   ```

   Resolution is `serve flag > environment > home config > derived default`.
   Keep these keys in the home config only: a project's `.red/config.yaml` may
   ask for Workers, but it may not redefine the machine's limit.

4. **Restart and adopt** — stop the daemon through its reporting verb:

   ```bash
   npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled stop
   ```

   Read the survival report before continuing. Workers are init-system units and
   survive the daemon stop: this is a restart, never an evacuation. There is no
   standalone `start` verb; #3217 established client auto-spawn, so start the
   successor through the same idempotent provisioning client:

   ```bash
   npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision --workspace host
   ```

5. **Confirm adoption from the successor** — read the live daemon again:

   ```bash
   npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled host-state
   ```

   Finish only when the configured value is present and its source is
   `home-config` — for `worker_ceiling`, confirm `ceiling.worker_count` and
   `ceiling.worker_source: home-config`. A `flag` or `environment` source means
   a higher-precedence declaration still overrides the home policy; remove or
   change that declaration, repeat the restart, and read back again.

</what-to-do>

<supporting-info>

## Scope Boundary

`/redskilled` is per-machine: it owns the daemon home, host ceilings, status,
and lifecycle. `/red-setup` is per-repository: it is the only authority allowed
to create a checkout's `.red/` and enable plugins there. Route repository setup
to `/red-setup`; route host daemon operation here.

Use the ADR 0091 npm direct-run form for every daemon operation. The published
binary is `red-skills-redskilled`; `redskilled` is only the daemon's name, and a
bare invocation is not installed on an operator's machine by default.

</supporting-info>
