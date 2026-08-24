---
"@reddb-io/redskilled-link": minor
---

`redskilled-link unit install|remove|status`: the Host companion's systemd unit is now operable outside onboarding — remove disables, deletes and reloads; status answers from both authorities (systemd's own words for the process, and the published `status.json` projection for what the link has done), and the projection finally has a reader (`readPublicLinkStatus`).
