---
"@reddb-io/redskilled": patch
---

Projects previously split between `remote:<slug>` and `github:<id>` identities are merged onto the github identity — control rows re-keyed with drain intent merged restrictively, duplicate workspace clones removed, displaced memory roots set aside as `.superseded`, and journal sessions re-keyed — once at boot for every cached alias and again the moment a new one is learned.
