---
"@reddb-io/red-skills": patch
---

The standing drain lives in the drain itself

`maintainStandingDrain` had **no caller**: its caller was the dev CLI engine
#4031 deleted, so the module that re-registered a lapsed standing drain sat in
the tree doing nothing while every drain recorded an intent nobody polled.

Its whole behaviour — *register when nothing is held* — now belongs to the drain
that carries its work (#4101), so the module is deleted rather than re-wired.
What made re-running safe is the missing half: `project-register` refuses a
second record so two sessions cannot silently replace each other's work, but a
drain re-run by the same operator, or by a new session repairing a standing
declaration, must not fail for saying the same thing twice. **A record already
held IS the answer**; any other registration failure still surfaces.

The `plugins.dev.afk.standing` declaration and its reader stay: the config is
documented and live, and what died is the module nothing called.
