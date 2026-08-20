---
name: unslop
working-mode: interactive
description: Cut AI tells from a piece of writing and give it a human voice. Use when the user invokes this skill on a draft, a doc, a PR body, or any prose surface.
disable-model-invocation: true
---

# Unslop

Edit text to remove AI patterns and add human voice.

<what-to-do>

Run the four steps in order on the given text. Do not skip the self-audit.

1. **Scan.** Read the text against the pattern catalog in
   `<supporting-info>` and mark every hit.
2. **Rewrite.** Fix each hit. Preserve the meaning and match the intended
   tone; replace only the wording.
3. **Add soul.** Removing patterns is half the job — sterile, voiceless
   writing is just as obvious. Apply the voice rules below.
4. **Self-audit.** Ask "what makes this obviously AI generated?" and fix the
   remaining tells.

**Voice rules for step 3:**

- **Have opinions.** React to facts instead of neutrally listing pros and cons.
- **Vary rhythm.** Short sentences. Then longer ones that take their time.
- **Acknowledge complexity.** "Impressive but also kind of unsettling" beats
  "impressive".
- **Use "I" when it fits.** First person is not unprofessional.
- **Let some mess in.** Perfect structure looks machine-made.
- **Be specific.** Not "this is concerning" but the concrete thing that
  concerns you.

✅ Preserve the author's meaning — this skill edits wording, never claims.
❌ Do not add new facts, praise, or hedges while rewriting.
❌ Do not swap one tell for another — an em dash removed is not a parenthesis
gained (pattern 13).

</what-to-do>

<supporting-info>

## Pattern catalog

### Content

1. **Puffery.** "pivotal moment", "testament to", "evolving landscape",
   "setting the stage for". Cut the puffery, state what happened.
2. **Name-dropping.** Listing outlets or authorities without content. Pick
   one, say what was said.
3. **Superficial -ing phrases.** "highlighting...", "ensuring...",
   "showcasing...", "fostering...". Delete, or expand with a real source.
4. **Promotional language.** "nestled", "vibrant", "breathtaking",
   "groundbreaking", "renowned". Use neutral description.
5. **Vague attributions.** "Experts believe", "Industry reports suggest".
   Name the source or delete.
6. **Formulaic challenges.** "Despite challenges... continues to thrive."
   Replace with specific facts.

### Language

7. **AI vocabulary.** Additionally, crucial, delve, enduring, enhance,
   fostering, garner, interplay, intricate, landscape (abstract), pivotal,
   showcase, tapestry (abstract), testament, underscore, vibrant. Replace
   with plain words.
8. **Fancy ways to say "is".** "serves as", "stands as", "boasts",
   "features". Say "is" or "has".
9. **"Not just X, but Y."** State the point directly.
10. **Rule of three.** Forcing ideas into groups of three. Use the natural
    number.
11. **Synonym cycling.** Protagonist, main character, central figure, hero in
    one paragraph. Pick one name per concept and repeat it.
12. **False ranges.** "from X to Y" where X and Y are not on a meaningful
    scale. List the topics directly.

### Style

13. **Em dash overuse.** Avoid em dashes entirely; use periods or commas, and
    do not reach for parentheses instead — that trades one tell for another.
    If a thought needs separation, end the sentence.
14. **Colon overuse.** A colon is fine before a list or an example, not as a
    mid-sentence connector. Rewrite so the point stands without the crutch.
15. **Boldface overuse.** Do not bold every proper noun or acronym.
16. **Inline-header lists.** The tell is a bold label and colon that restate
    the line ("**Performance:** Performance improved..."). Convert to prose.
    A bold lead-in that ends in a period, names the item, and is followed by
    genuinely new detail is fine.
17. **Title case headings.** Use sentence case.
18. **Decorative emojis.** Remove from headings and bullets.
19. **Curly quotes.** Replace with straight quotes.

### Communication artifacts

20. **Chatbot phrases.** "I hope this helps!", "Let me know if...", "Of
    course!". Remove.
21. **Cutoff disclaimers.** "While specific details are limited...". Find
    sources or remove.
22. **Sycophantic tone.** "Great question! You're absolutely right!" Respond
    directly.

### Filler

23. **Filler phrases.** "In order to" becomes "To". "Due to the fact that"
    becomes "Because". "It is important to note that" gets deleted.
24. **Excessive hedging.** "could potentially possibly be argued that it
    might" becomes "may".
25. **Generic conclusions.** "The future looks bright." State specific plans
    or facts.

### Jargon

26. **Abstract metaphor nouns.** Substrate, wedge, vector, locus, nexus,
    primitive (as noun), harness (as metaphor), bedrock, scaffolding (as
    metaphor), modality, paradigm, north star, flywheel, endgame. These read
    as technical but usually have a plainer concrete word: "substrate"
    becomes "base", "wedge in" becomes "add", "vector" becomes "way",
    "endgame" becomes "the last phase". Pick the concrete word.

### Plain speech

27. **Say what it does, not how it feels.** "SQL you can read" names a
    feeling; the fix names the mechanism or a number. Ask what the sentence
    tells the reader to do or know, then write that. If it cannot be restated
    as a concrete instruction, fact, or number, cut it. And if the sentence
    could appear unchanged in another project's docs, it says nothing about
    this one — cut it.
28. **Shorten or split dense sentences.** If the reader has to backtrack, break
    the sentence in two. One idea per sentence.
29. **Active voice.** Catch "is/are/was/were + past participle" and name the
    actor: "queries are validated" becomes "the compiler validates queries".
    Passive is fine only when the actor is unknown or genuinely does not
    matter.
30. **Cut adverbs, or use a stronger verb.** "runs quickly" becomes "is fast"
    or the number. An adverb propping up a weak verb means the verb is wrong.
31. **Prefer the plain word.** "utilize" becomes "use", "leverage" becomes
    "use", "facilitate" becomes "help", "in the event that" becomes "if".

</supporting-info>
