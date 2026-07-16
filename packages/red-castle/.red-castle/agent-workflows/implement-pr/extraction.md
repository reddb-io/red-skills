Emit a single `<output>` block as the last thing in your response.

Do not change files.
Do not run commands.
Do not include text outside the `<output>` block.

```json
<output>
{
  "threadReplies": [
    { "commentId": "GraphQL node id from PR_COMMENTS_JSON", "body": "Markdown reply" }
  ],
  "newInlineComments": [
    { "path": "relative/file.ts", "line": 123, "body": "Markdown comment" }
  ],
  "topLevelComments": [
    { "body": "Markdown comment" }
  ]
}
</output>
```

Use empty arrays when there are no replies or comments.
