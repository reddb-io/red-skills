---
"@reddb-io/red-skills": minor
---

Territory scoping for shared issue pools: new `tag:<value>` label family + author filter. `/afk --tags a,b` drains only issues carrying EVERY requested tag label (AND semantics; untagged issues are outside every tag-scoped fleet) and `/afk --user login|@me` filters by issue author (`@me` resolved to a concrete login at launch); both fold into the fleet `selector` (`tags`/`user` facets) across CLI, supervise forwarding, fleets.toonl persistence, and the castle MCP `fleet_*`/`queue_status` surface. `/go --tags` stamps the labels on the minted `lane:go` issue (auto-created when missing); `/to-spec`/`/to-tickets` stamp and inherit them Spec→Ticket.
