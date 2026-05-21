import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface StoredNote {
  id: string;
  path: string;
  createdAt: string;
  fact: string;
}

/** Lowercase, hyphenate, and clip a fact into a filename-safe slug. */
export function slugify(text: string, maxLen = 48): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return slug || "note";
}

/** A UTC timestamp safe to embed in a filename: 2026-05-21T14-41-36-000Z. */
function fileStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Write a fact as a plain markdown note under `notesDir` and return its
 * metadata. The note is human-readable markdown with YAML frontmatter — the
 * canonical store in markdown-only mode, no engine involved.
 */
export async function storeNote(
  notesDir: string,
  fact: string,
  now: Date = new Date(),
): Promise<StoredNote> {
  const trimmed = fact.trim();
  if (!trimmed) throw new Error("cannot store an empty fact");

  await mkdir(notesDir, { recursive: true });

  const createdAt = now.toISOString();
  const id = `${fileStamp(now)}-${slugify(trimmed)}`;
  const path = join(notesDir, `${id}.md`);

  const body = [
    "---",
    `id: ${id}`,
    `created_at: ${createdAt}`,
    "---",
    "",
    trimmed,
    "",
  ].join("\n");

  await writeFile(path, body, { encoding: "utf8", flag: "wx" });
  return { id, path, createdAt, fact: trimmed };
}
