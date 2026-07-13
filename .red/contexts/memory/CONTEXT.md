# RedSkills Memory

The `memory` context names the persistent-project-memory language for
RedSkills: governed operational memory, recall, extraction evidence, and —
since the 2026-07-13 session-continuity review — captured conversation
history.

## Language

**Session Transcript**:
The verbatim, per-repo record of one agent conversation, persisted in TOON —
never JSONL — with permanent retention; pruning is a deliberate operator act,
never automatic expiry.
_Avoid_: session log, chat dump, conversation JSONL

**Session Summary**:
The deterministic, indexable digest of a **Session Transcript** (decisions,
open threads, dates) that joins the recall graph as a first-class node and
ranks inside the same hybrid recall fusion as every other memory source;
optionally enriched later by a batch LLM pass, never by a per-turn one.
_Avoid_: session note, auto-summary

**Session Backfill**:
The one-time import of pre-existing agent conversation history — Claude Code
and Codex from day one — into **Session Transcripts** and **Session
Summaries**, so continuity starts from the operator's real history instead of
from zero.
_Avoid_: history migration, session import script

**Transcript Citation**:
The recall contract for conversation history: an answer grounded in a
**Session Transcript** cites the session, the date, and the verbatim wording,
and states plainly when no transcript supports the claim instead of
paraphrasing from ranking artifacts.
_Avoid_: source link, reference blob

**Verbatim-with-outbound-scrub**:
The storage posture for **Session Transcripts**: bytes persist exactly as
spoken, locally and unpublished; redaction happens only on surfaces that
export or publish, never on ingest.
_Avoid_: input scrubbing, redact-on-write
