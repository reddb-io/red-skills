---
"@reddb-io/redskilled": patch
---

The Worker body cut declares the retry-policy module. #4175 (landed by an
autonomous Worker) added `retry-policy.ts` to the Worker's ACP directory
without the body-control-cut declaration, so the cut's own suite was red on
main. The module is declared with what it defines and why it runs in the body.
