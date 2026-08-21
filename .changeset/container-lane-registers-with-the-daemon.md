---
"@reddb-io/afk-container": patch
"@reddb-io/dev": patch
---

The container lane runs a Worker body that exists. `worker-container` shelled
out to `red-skills-dev run --issues N`, a binary #4031 deleted with its
36-command router, so every container run died at command-not-found before it
reached a queue. The container is now a HOST: it supervises `serve` from the one
shipped binary of the execution chain, clones each target repository once as
that project's workspace, registers the project through the daemon's Project
control surface, and follows the drain — so the queue loop is the daemon's
demand loop and the Worker body is `@reddb-io/worker` (ADR 0148), the same one
every other lane runs. The `dev-cli-binary` crossing of the extinct-execution
chain drops the container entry it was holding, and a new ratchet pins the
lane's command against the `bin` map that declares what the repository ships.
