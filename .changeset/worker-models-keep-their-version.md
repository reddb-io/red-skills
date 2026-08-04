---
"@reddb-io/red-skills": patch
---

Worker rows now keep the model version in their compact `run=` label. Claude
model IDs such as `claude-opus-4-8` render as `opus-4.8`, trailing date stamps
are omitted, and genuinely versionless family names remain bare.
