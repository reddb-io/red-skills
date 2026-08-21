---
"@reddb-io/dev": patch
---

`weekly_review` flags Standing orders that recur across the week's drains as
CLAUDE.md promotion candidates. An order appended under one drain is that
drain's correction; the same order under two drains is a pattern the repo
should carry, and until now that signal lived only in an operator's memory of
what they kept retyping. The weekly report now names the order, the drains it
recurred in, and how many times it was appended — and stops there: promotion is
a human PR, so the review writes to neither CLAUDE.md nor the register. Orders
stamped outside the window, or carrying no usable timestamp, are counted in the
warnings rather than attributed to a drain nobody can name.
