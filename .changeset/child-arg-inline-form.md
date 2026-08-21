---
"@reddb-io/redskilled": patch
---

Adapter child args survive the Worker's argv parser. An adapter endpoint's
args start with dashes (`-y`, `-p`), and the `--child-arg <value>` pair form
read the next dash token as a flag — every adapter Worker died at its own
front door with "--child-arg requires a value". Admission now emits the
inline `--child-arg=<value>` form the shared parser already recognises.
