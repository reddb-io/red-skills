export type AttemptStatus = "blocked" | "no-sentinel" | "merge-conflict" | "done" | "discarded";

export interface EnvelopeSection {
  name: string;
  body: string;
  fenced?: boolean;
}

export interface EnvelopeInput {
  status: AttemptStatus;
  worker: string;
  duration: string;
  diff: string;
  attempt: number;
  mergeSha?: string;
  sections?: EnvelopeSection[];
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildEnvelope(input: EnvelopeInput): string {
  const merge = input.mergeSha ? ` · merge: ${input.mergeSha}` : "";
  const summary = `worker \`${input.worker}\` · status: ${input.status} · duration: ${input.duration} · diff: ${input.diff} · attempt: ${input.attempt}${merge}`;
  const body = (input.sections ?? [])
    .map((section) => {
      const content = section.fenced ? `\n\`\`\`\n${section.body}\n\`\`\`\n` : `\n${section.body}\n`;
      return `<details data-section="${escapeHtml(section.name)}"><summary>${escapeHtml(section.name)}</summary>\n${content}\n</details>`;
    })
    .join("\n\n");
  return `<details data-attempt-status="${input.status}"><summary>${summary}</summary>\n\n${body}\n\n</details>\n`;
}
