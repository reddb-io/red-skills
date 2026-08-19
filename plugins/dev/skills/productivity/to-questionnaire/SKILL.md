---
name: to-questionnaire
working-mode: interactive
description: Turn knowledge the user cannot supply into a Markdown questionnaire for the person who can. Use only when the user invokes this skill.
disable-model-invocation: true
---

# To Questionnaire

Turn a knowledge gap into a Markdown questionnaire that one recipient can
answer asynchronously or during a meeting.

<what-to-do>

## 1. Identify The Recipient

**Grill the send, not the subject** — ask who will receive the questionnaire,
what they know, and how they relate to the user. Ask this in one exchange.

Done when the recipient and the knowledge they hold are clear.

## 2. Define The Return

**Ask what must come back** — collect the decisions and facts the user needs
from that recipient. Ask this in one exchange. The user does not need to answer
the subject; that missing knowledge belongs in the questionnaire.

Done when every required decision or fact is named.

## 3. Write The Questionnaire

**Draft for the knowledge gap** — write `to-questionnaire-<slug>.md` in the
current directory. Cover every item from step 2. Report the path.

Done when the file exists and each required return has one or more questions.

</what-to-do>

<supporting-info>

## Document Shape

Use this structure:

```markdown
# <Questionnaire title>

**Purpose:** <why this exists and the decision that depends on it>

**From:** <user> — **To:** <recipient> — **How your answers will be used:** <use>

## Context

<One short paragraph with enough context to answer well.>

## How To Answer

<Deadline and expected effort. Invite partial answers and explicit uncertainty.>

## <Theme>

### <One question about one idea?>

_Why this matters: <include only when the question can be misread>._

>

## Anything Else?

What did we not ask that we should know?
```

Put the highest-value questions first; an asynchronous request can get only one
pass. Group more than a handful of questions under `##` theme headings. Give
each question its own answer stub. Split compound questions into one idea each.

</supporting-info>
