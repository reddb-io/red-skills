export interface IssueReference {
  number: number;
  title?: string;
  url?: string;
}

export type IssueReferenceLookup = (issue: number) => Promise<IssueReference | undefined>;

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function escapeMarkdownUrl(value: string): string {
  return value.replace(/\)/g, "%29");
}

export function renderIssueReference(ref: IssueReference): string {
  const title = ref.title?.trim();
  const url = ref.url?.trim();
  if (!title || !url) return `#${ref.number}`;
  return `[${escapeMarkdownLinkText(title)} (#${ref.number})](${escapeMarkdownUrl(url)})`;
}

export function renderIssueReferenceList(refs: readonly IssueReference[]): string {
  return refs.map(renderIssueReference).join(", ");
}

export async function resolveIssueReferences(
  issues: readonly number[],
  lookup?: IssueReferenceLookup,
): Promise<Map<number, IssueReference>> {
  const out = new Map<number, IssueReference>();
  for (const issue of issues) out.set(issue, { number: issue });
  if (!lookup) return out;

  await Promise.all(
    [...new Set(issues)].map(async (issue) => {
      try {
        const resolved = await lookup(issue);
        if (resolved?.title?.trim() && resolved.url?.trim()) {
          out.set(issue, { number: issue, title: resolved.title, url: resolved.url });
        }
      } catch {
        // Human-facing enrichment must never block the machine transition.
      }
    }),
  );
  return out;
}

export async function enrichIssueReferences(
  text: string,
  lookup?: IssueReferenceLookup,
): Promise<string> {
  const ids = [...new Set([...text.matchAll(/#([0-9]+)/g)].map((m) => Number(m[1])))];
  if (ids.length === 0) return text;
  const refs = await resolveIssueReferences(ids, lookup);
  return text.replace(/#([0-9]+)/g, (raw, idRaw: string) => renderIssueReference(refs.get(Number(idRaw)) ?? { number: Number(idRaw) || 0 }) || raw);
}
