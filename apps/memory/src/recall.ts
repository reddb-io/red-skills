import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface RecallHit {
  id: string;
  path: string;
  score: number;
  excerpt: string;
}

/** Split text into lowercased word tokens. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(Boolean);
}

/** Strip a leading YAML frontmatter block, returning the note body. */
export function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  const after = raw.indexOf("\n", end + 1);
  return after === -1 ? "" : raw.slice(after + 1);
}

/**
 * Full-text search over the markdown notes in `notesDir`. Each note is scored
 * by how many times the query's terms appear in its body; notes with no match
 * are dropped, and the rest are returned highest-score first.
 *
 * Returns an empty array if `notesDir` does not exist yet (nothing stored).
 */
export async function recall(
  notesDir: string,
  query: string,
  limit = 10,
): Promise<RecallHit[]> {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  let entries: string[];
  try {
    entries = (await readdir(notesDir)).filter((f) => f.endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const hits: RecallHit[] = [];
  for (const file of entries) {
    const path = join(notesDir, file);
    const body = stripFrontmatter(await readFile(path, "utf8")).trim();
    const tokens = tokenize(body);
    let score = 0;
    for (const token of tokens) {
      if (terms.includes(token)) score += 1;
    }
    if (score > 0) {
      hits.push({
        id: file.replace(/\.md$/, ""),
        path,
        score,
        excerpt: body.split("\n")[0]?.slice(0, 200) ?? "",
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return hits.slice(0, limit);
}
