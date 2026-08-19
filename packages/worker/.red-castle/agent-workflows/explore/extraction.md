Emit a single `<output>` block as the last thing in your response.

Do not change files.
Do not run commands.
Do not include text outside the `<output>` block.

```json
<output>
{
  "comment": "The full markdown comment to post on the issue. Cover the topics you explored (difficulty, relevant files, claims, open questions, possible approach), including only those you have something useful to say about."
}
</output>
```

The `comment` field is required and must be non-empty markdown.
