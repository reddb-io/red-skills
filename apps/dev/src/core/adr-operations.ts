/** Pure planners and injected IO shells for ADR 0112 lifecycle operations. */

export interface StatusAndSuccessorInput {
  path: string;
  text: string;
  status: "superseded" | "deprecated" | "inert";
  successors: readonly string[];
}

export interface AdrTextPlan {
  path: string;
  text: string;
}

export interface IndexArchiveInput {
  path: string;
  text: string;
  number: string;
}

export interface ArchiveMoveInput extends StatusAndSuccessorInput {
  indexPath: string;
  indexText: string;
}

export interface ArchiveMovePlan {
  from: string;
  to: string;
  adrText: string;
  indexPath: string;
  indexText: string;
}

export interface StalePathFixInput {
  path: string;
  text: string;
  stalePath: string;
  replacementPath: string;
  note: string;
}

export interface AdrOperationFs {
  writeFile(path: string, text: string): Promise<void>;
}

export interface AdrOperationGit {
  mv(from: string, to: string): Promise<void>;
}

export interface AdrOperationIo {
  fs: AdrOperationFs;
  git: AdrOperationGit;
}

/** Set an ADR's terminal status and successor pointer without editing its Decision. */
export function planStatusAndSuccessor(input: StatusAndSuccessorInput): AdrTextPlan {
  const successor = input.successors[0];
  if (!successor && input.status !== "inert") {
    throw new Error(`A ${input.status} ADR must name a successor`);
  }

  const statusLine = input.status === "inert"
    ? "Inert — fully shipped, no longer guidance."
    : input.status === "deprecated"
      ? `Deprecated; superseded by ADR ${successor}.`
      : `Superseded by ADR ${successor}.`;
  const pointer = input.successors.length > 0 ? input.successors.join(", ") : "none (inert)";

  const status = [
    "## Status",
    "",
    statusLine,
    "",
    `superseded-by: ${pointer}`,
    "",
    "",
  ].join("\n");
  const heading = /^##\s+Status\s*$/m.exec(input.text);
  let text: string;
  if (heading) {
    const bodyStart = heading.index + heading[0].length;
    const nextHeading = /^##\s+/m.exec(input.text.slice(bodyStart));
    const sectionEnd = nextHeading ? bodyStart + nextHeading.index : input.text.length;
    text = input.text.slice(0, heading.index) + status + input.text.slice(sectionEnd);
  } else {
    const title = /^#\s+.+$/m.exec(input.text);
    if (!title) throw new Error(`ADR has no title: ${input.path}`);
    const titleEnd = title.index + title[0].length;
    text = input.text.slice(0, titleEnd)
      + "\n\n"
      + status
      + input.text.slice(titleEnd).replace(/^\n+/, "");
  }
  return { path: input.path, text };
}

/** Apply a planned status edit through an injected filesystem. */
export async function applyStatusAndSuccessor(
  plan: AdrTextPlan,
  fs: AdrOperationFs,
): Promise<void> {
  await fs.writeFile(plan.path, plan.text);
}

/** Move one ADR's existing INDEX bullet into the Archived section. */
export function planIndexArchive(input: IndexArchiveInput): AdrTextPlan {
  if (!/^\d{4}$/.test(input.number)) throw new Error(`Invalid ADR number: ${input.number}`);
  const lines = input.text.split("\n");
  const bulletIndex = lines.findIndex((line) => new RegExp(`^- \\*\\*${input.number}\\*\\*`).test(line));
  if (bulletIndex < 0) throw new Error(`ADR ${input.number} has no INDEX bullet`);
  const [bullet] = lines.splice(bulletIndex, 1);

  const archivedStart = lines.findIndex((line) => /^## Archived\s*$/.test(line));
  if (archivedStart < 0) throw new Error("ADR INDEX has no Archived section");
  const nextHeadingOffset = lines.slice(archivedStart + 1).findIndex((line) => /^##\s+/.test(line));
  const archivedEnd = nextHeadingOffset < 0 ? lines.length : archivedStart + 1 + nextHeadingOffset;
  const empty = "_The archive is empty — no ADR has been retired yet._";
  const emptyIndex = lines.findIndex((line, index) => index > archivedStart && index < archivedEnd && line === empty);
  if (emptyIndex >= 0) {
    lines[emptyIndex] = bullet!;
  } else {
    const archivedBullets = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line, index }) => index > archivedStart && index < archivedEnd && /^- \*\*\d{4}\*\*/.test(line));
    const insertAt = archivedBullets.at(-1)?.index;
    lines.splice(insertAt === undefined ? archivedEnd : insertAt + 1, 0, bullet!);
  }
  return { path: input.path, text: lines.join("\n") };
}

/** Apply a planned INDEX resync through an injected filesystem. */
export async function applyIndexArchive(plan: AdrTextPlan, fs: AdrOperationFs): Promise<void> {
  await fs.writeFile(plan.path, plan.text);
}

/** Plan the status, history-preserving archive path, and INDEX change together. */
export function planArchiveMove(input: ArchiveMoveInput): ArchiveMovePlan {
  const match = input.path.match(/^\.red\/adr\/(\d{4}-.+\.md)$/);
  if (!match) throw new Error(`ADR is not in the active lane: ${input.path}`);
  const file = match[1]!;
  const status = planStatusAndSuccessor(input);
  const index = planIndexArchive({
    path: input.indexPath,
    text: input.indexText,
    number: file.slice(0, 4),
  });
  return {
    from: input.path,
    to: `.red/adr/archive/${file}`,
    adrText: status.text,
    indexPath: index.path,
    indexText: index.text,
  };
}

/** Apply an archive plan with a real git move between the two planned writes. */
export async function applyArchiveMove(plan: ArchiveMovePlan, io: AdrOperationIo): Promise<void> {
  await io.fs.writeFile(plan.from, plan.adrText);
  await io.git.mv(plan.from, plan.to);
  await io.fs.writeFile(plan.indexPath, plan.indexText);
}

/** Replace a backticked stale path outside `## Decision`, recording why it moved. */
export function planStalePathFix(input: StalePathFixInput): AdrTextPlan {
  const heading = /^##\s+Decisions?\s*$/m.exec(input.text);
  const replace = (text: string): string =>
    text.replaceAll(
      `\`${input.stalePath}\``,
      `\`${input.replacementPath}\` *(stale-path note: ${input.note})*`,
    );

  let text: string;
  if (!heading) {
    text = replace(input.text);
  } else {
    const bodyStart = heading.index + heading[0].length;
    const nextHeading = /^##\s+/m.exec(input.text.slice(bodyStart));
    const bodyEnd = nextHeading ? bodyStart + nextHeading.index : input.text.length;
    text = replace(input.text.slice(0, heading.index))
      + input.text.slice(heading.index, bodyEnd)
      + replace(input.text.slice(bodyEnd));
  }

  if (text === input.text) throw new Error(`No editable stale-path occurrence: ${input.stalePath}`);
  return { path: input.path, text };
}

/** Apply a planned stale-path prose repair through an injected filesystem. */
export async function applyStalePathFix(plan: AdrTextPlan, fs: AdrOperationFs): Promise<void> {
  await fs.writeFile(plan.path, plan.text);
}
