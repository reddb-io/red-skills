# RedSkills / Redskilled separation

RedSkills owns content and declarative marketplace configuration. Redskilled owns
all software and distribution, including npm packages named `@reddb-io/red-skills`
and `@reddb-io/red-skills-{dev,memory,brain,internal}`. Package names do not follow
repository names. Internal/vendor workspaces keep their existing publication policy.

The repos are siblings, not nested submodules. Versions evolve independently.
RedSkills declares its compatible runtime in `runtime.toon`; Redskilled pins content
by Git SHA in `skills.lock.toon`. Releases compose this content with runtime helpers
without maintaining a second editable skills tree.

Manifests invoke preinstalled commands. Runtime installation precedes host activation.
No package resolution, bootstrap shell or executable files belong to RedSkills.
Existing caches, project state and daemon paths remain unchanged.

The initial Redskilled snapshot records its source SHA in `migration/source.toon`.
Historical commits, closed issues and releases remain in RedSkills. New software
artifacts and open software issues belong to Redskilled. Use `req:owner/repo#number`
for cross-repository dependency labels; local `req:number` remains valid. Periodic
unblock passes resolve qualified refs; local close cascades hold unresolved remote
requirements until that pass confirms closure.

Publish the compatible runtime before activating the new marketplace declarations.
Keep the old publisher off before enabling the new one. Rollback selects the previous
verified runtime/content pair without deleting published versions or user state.
