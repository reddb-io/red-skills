---
"@reddb-io/red-skills": patch
---

The dashboard shows every project the host is watching, and its two curves line up

Three complaints, one screen. The dashboard answered for ONE project — the
caller's — on a machine that routinely holds several, so an operator asking what
`redskilled` was doing got a view that looked like the directory they happened
to be standing in, with a second project draining beside it invisible. It now
lists every project the daemon watches, each with its Worker count, its queue at
the last poll and how old that look is, and marks the current directory's
project with a star rather than hiding the rest.

The two 48-hour sparklines also stopped lying about their length. Their labels
were unpadded — `tokens` and `Tickets` differ by one character — so the curves
began one column apart and could not be read against each other, which is the
only thing two stacked sparklines are for. Both labels now share one padded
column and one casing.

The mark for an hour that reported nothing changed from `·` to `─`. The middle
dot is East Asian AMBIGUOUS width, so a terminal may draw it half as wide as the
block elements beside it: same 48 glyphs, visibly shorter curve. The box-drawing
character is sized with the blocks and still reads as absence rather than as the
zero the lowest block already means.
