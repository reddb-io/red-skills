/** Pure planners and injected IO shells for ADR 0127 lifecycle operations. */

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

export interface IndexReviewAnnotationInput {
  path: string;
  text: string;
  number: string;
  reviewedOn: string;
  baseSha: string;
}

export interface ArchiveMoveInput extends StatusAndSuccessorInput {
  indexPath: string;
  indexText: string;
}

export interface ArchiveMovePlan {
  from: string;
  to: string;
  originalAdrText: string;
  adrText: string;
  indexPath: string;
  originalIndexText: string;
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
  /**
   * Delete a path. Only the composite planners need it — supply it whenever a
   * split or merge may have to roll back the records it minted.
   */
  rm?(path: string): Promise<void>;
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
  const invalidSuccessor = input.successors.find((number) => !/^\d{4}$/.test(number));
  if (invalidSuccessor) throw new Error(`Invalid ADR successor: ${invalidSuccessor}`);
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

  const pointerLine = `superseded-by: ${pointer}`;
  const status = ["## Status", "", statusLine, "", pointerLine, "", ""].join("\n");
  const heading = /^##\s+Status\s*$/m.exec(input.text);
  let text: string;
  if (heading) {
    const bodyStart = heading.index + heading[0].length;
    const nextHeading = /^##\s+/m.exec(input.text.slice(bodyStart));
    const sectionEnd = nextHeading ? bodyStart + nextHeading.index : input.text.length;
    const originalBody = input.text.slice(bodyStart, sectionEnd);
    const declaration = /^([ \t]*)(\S.*)$/m.exec(originalBody);
    if (!declaration) throw new Error(`ADR Status has no declaration: ${input.path}`);
    const declarationStart = declaration.index + declaration[1]!.length;
    let body = originalBody.slice(0, declarationStart)
      + statusLine
      + originalBody.slice(declarationStart + declaration[2]!.length);
    const existingPointer = /^[ \t]*superseded-by:.*$/m.exec(body);
    if (existingPointer) {
      body = body.slice(0, existingPointer.index) + pointerLine + body.slice(existingPointer.index + existingPointer[0].length);
    } else {
      body = body.slice(0, declarationStart + statusLine.length)
        + `\n\n${pointerLine}`
        + body.slice(declarationStart + statusLine.length);
    }
    text = input.text.slice(0, bodyStart) + body + input.text.slice(sectionEnd);
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

/** Plan the visible review date and short base SHA on one existing INDEX bullet. */
export function planIndexReviewAnnotation(input: IndexReviewAnnotationInput): AdrTextPlan {
  if (!/^\d{4}$/.test(input.number)) throw new Error(`Invalid ADR number: ${input.number}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.reviewedOn)) {
    throw new Error(`Invalid ADR review date: ${input.reviewedOn}`);
  }
  if (!/^[0-9a-f]{7,12}$/i.test(input.baseSha)) {
    throw new Error(`Invalid short base SHA: ${input.baseSha}`);
  }
  const bullet = new RegExp(`^- \\*\\*${input.number}\\*\\*.*$`, "m").exec(input.text);
  if (!bullet) throw new Error(`ADR ${input.number} has no INDEX bullet`);
  const unmarked = bullet[0].replace(/\s+— reviewed \d{4}-\d{2}-\d{2} @ [0-9a-f]{7,12}\s*$/i, "");
  const annotation = `${unmarked} — reviewed ${input.reviewedOn} @ ${input.baseSha}`;
  return {
    path: input.path,
    text: input.text.slice(0, bullet.index) + annotation + input.text.slice(bullet.index + bullet[0].length),
  };
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
    originalAdrText: input.text,
    adrText: status.text,
    indexPath: index.path,
    originalIndexText: input.indexText,
    indexText: index.text,
  };
}

/** Apply an archive plan with a real git move between the two planned writes. */
export async function applyArchiveMove(plan: ArchiveMovePlan, io: AdrOperationIo): Promise<void> {
  try {
    await io.fs.writeFile(plan.from, plan.adrText);
  } catch (error) {
    await io.fs.writeFile(plan.from, plan.originalAdrText);
    throw error;
  }
  try {
    await io.git.mv(plan.from, plan.to);
  } catch (error) {
    await io.fs.writeFile(plan.from, plan.originalAdrText);
    throw error;
  }
  try {
    await io.fs.writeFile(plan.indexPath, plan.indexText);
  } catch (error) {
    await io.fs.writeFile(plan.indexPath, plan.originalIndexText);
    await io.git.mv(plan.to, plan.from);
    await io.fs.writeFile(plan.from, plan.originalAdrText);
    throw error;
  }
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

// ---------------------------------------------------------------------------
// renumber
// ---------------------------------------------------------------------------

export interface RenumberInput {
  /** Repo-relative path in either the active lane or `.red/adr/archive/`. */
  path: string;
  text: string;
  /** The four-digit number to move to. */
  toNumber: string;
  indexPath: string;
  indexText: string;
}

export interface RenumberPlan {
  from: string;
  to: string;
  originalAdrText: string;
  adrText: string;
  indexPath: string;
  originalIndexText: string;
  indexText: string;
}

const ADR_PATH = /^(\.red\/adr\/(?:archive\/)?)(\d{4})-(.+\.md)$/;

/** Move an ADR to a free number, keeping filename, H1, and INDEX bullet in step. */
export function planRenumber(input: RenumberInput): RenumberPlan {
  if (!/^\d{4}$/.test(input.toNumber)) throw new Error(`Invalid ADR number: ${input.toNumber}`);
  const match = ADR_PATH.exec(input.path);
  if (!match) throw new Error(`ADR is not in a known lane: ${input.path}`);
  const lane = match[1]!;
  const fromNumber = match[2]!;
  const slug = match[3]!;
  if (fromNumber === input.toNumber) throw new Error(`ADR ${fromNumber} already has that number`);

  const heading = /^#\s+(\d{4})\s+—\s+(.+)$/m.exec(input.text);
  if (!heading) throw new Error(`ADR H1 must read \`# ${fromNumber} — Title\`: ${input.path}`);
  if (heading[1] !== fromNumber) throw new Error(`ADR H1 says ${heading[1]}, filename says ${fromNumber}`);
  const adrText =
    input.text.slice(0, heading.index) +
    `# ${input.toNumber} — ${heading[2]!}` +
    input.text.slice(heading.index + heading[0].length);

  const bullet = new RegExp(`^- \\*\\*${fromNumber}\\*\\*`, "m");
  if (!bullet.test(input.indexText)) throw new Error(`ADR ${fromNumber} has no INDEX bullet`);
  if (new RegExp(`^- \\*\\*${input.toNumber}\\*\\*`, "m").test(input.indexText)) {
    throw new Error(`ADR number ${input.toNumber} already has an INDEX bullet`);
  }
  const indexText = input.indexText.replace(bullet, `- **${input.toNumber}**`);

  return {
    from: input.path,
    to: `${lane}${input.toNumber}-${slug}`,
    originalAdrText: input.text,
    adrText,
    indexPath: input.indexPath,
    originalIndexText: input.indexText,
    indexText,
  };
}

/** Apply a renumber with a real `git mv`, compensating on any failed step. */
export async function applyRenumber(plan: RenumberPlan, io: AdrOperationIo): Promise<void> {
  await applyArchiveMove(
    {
      from: plan.from,
      to: plan.to,
      originalAdrText: plan.originalAdrText,
      adrText: plan.adrText,
      indexPath: plan.indexPath,
      originalIndexText: plan.originalIndexText,
      indexText: plan.indexText,
    },
    io,
  );
}

// ---------------------------------------------------------------------------
// re-index
// ---------------------------------------------------------------------------

export interface IndexEntryInput {
  path: string;
  text: string;
  number: string;
  /** The bullet text after the bolded number, without leading whitespace. */
  entry: string;
  /** The INDEX heading the bullet belongs under, e.g. `## Repo structure & contexts`. */
  section: string;
}

/**
 * Place one ADR's bullet under the named INDEX theme, moving it there when it
 * already sits elsewhere. This is the re-index primitive — one bullet, one
 * home, no other line touched.
 */
export function planIndexEntry(input: IndexEntryInput): AdrTextPlan {
  if (!/^\d{4}$/.test(input.number)) throw new Error(`Invalid ADR number: ${input.number}`);
  const heading = input.section.startsWith("#") ? input.section : `## ${input.section}`;
  const lines = input.text.split("\n");

  const existing = lines.findIndex((line) => new RegExp(`^- \\*\\*${input.number}\\*\\*`).test(line));
  if (existing >= 0) lines.splice(existing, 1);

  const sectionStart = lines.findIndex((line) => line.trim() === heading);
  if (sectionStart < 0) throw new Error(`ADR INDEX has no section: ${heading}`);
  const nextOffset = lines.slice(sectionStart + 1).findIndex((line) => /^##\s+/.test(line));
  const sectionEnd = nextOffset < 0 ? lines.length : sectionStart + 1 + nextOffset;

  const bullets = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => index > sectionStart && index < sectionEnd && /^- /.test(line));
  const insertAt = bullets.at(-1)?.index;
  lines.splice(insertAt === undefined ? sectionEnd : insertAt + 1, 0, `- **${input.number}** ${input.entry}`);

  return { path: input.path, text: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// split and merge — supersede-and-replace, composed from the primitives above
// ---------------------------------------------------------------------------

export interface AdrDraft {
  /** The four-digit number allocated to the new record. */
  number: string;
  /** Repo-relative destination, e.g. `.red/adr/0127-totipotent-adr-editor.md`. */
  path: string;
  text: string;
  /** The bullet text this record gets in the INDEX. */
  indexEntry: string;
  /** The INDEX heading the bullet belongs under. */
  indexSection: string;
}

export interface AdrArchiveStep {
  from: string;
  to: string;
  originalAdrText: string;
  adrText: string;
}

export interface AdrCompositePlan {
  /** New records to write, in order. */
  creates: AdrTextPlan[];
  /** Originals to status and `git mv` into the archive lane, in order. */
  archives: AdrArchiveStep[];
  indexPath: string;
  originalIndexText: string;
  /** The INDEX after every archive resync and every new bullet. */
  indexText: string;
}

export interface AdrOriginal {
  path: string;
  text: string;
}

export interface SplitInput {
  original: AdrOriginal;
  /** The focused records the original becomes — at least two. */
  drafts: readonly AdrDraft[];
  indexPath: string;
  indexText: string;
}

export interface MergeInput {
  /** The records being consolidated — at least two. */
  originals: readonly AdrOriginal[];
  successor: AdrDraft;
  indexPath: string;
  indexText: string;
}

export interface AbsorbInput {
  /** The active ADR that remains authoritative after incorporating amendments. */
  governing: AdrOriginal;
  /** Complete post-absorb text for the governing ADR. */
  rewrittenGoverningText: string;
  /** Active amendment records that become auxiliaries in the archive. */
  auxiliaries: readonly AdrOriginal[];
  indexPath: string;
  indexText: string;
}

export interface AdrAbsorbPlan {
  governing: {
    path: string;
    originalText: string;
    text: string;
  };
  archives: AdrArchiveStep[];
  indexPath: string;
  originalIndexText: string;
  indexText: string;
}

function draftNumbers(drafts: readonly AdrDraft[]): string[] {
  return drafts.map((draft) => draft.number);
}

/** Archive one original as superseded by `successors`, threading the INDEX. */
function archiveStep(
  original: AdrOriginal,
  successors: readonly string[],
  indexPath: string,
  indexText: string,
): { step: AdrArchiveStep; indexText: string } {
  const plan = planArchiveMove({
    path: original.path,
    text: original.text,
    status: "superseded",
    successors,
    indexPath,
    indexText,
  });
  return {
    step: { from: plan.from, to: plan.to, originalAdrText: plan.originalAdrText, adrText: plan.adrText },
    indexText: plan.indexText,
  };
}

function addDraftBullets(
  drafts: readonly AdrDraft[],
  indexPath: string,
  indexText: string,
): string {
  let text = indexText;
  for (const draft of drafts) {
    text = planIndexEntry({
      path: indexPath,
      text,
      number: draft.number,
      entry: draft.indexEntry,
      section: draft.indexSection,
    }).text;
  }
  return text;
}

/** Split one overloaded record into N focused ones, archiving the original. */
export function planSplit(input: SplitInput): AdrCompositePlan {
  if (input.drafts.length < 2) throw new Error("A split must mint at least two records");
  const { step, indexText } = archiveStep(
    input.original,
    draftNumbers(input.drafts),
    input.indexPath,
    input.indexText,
  );
  return {
    creates: input.drafts.map((draft) => ({ path: draft.path, text: draft.text })),
    archives: [step],
    indexPath: input.indexPath,
    originalIndexText: input.indexText,
    indexText: addDraftBullets(input.drafts, input.indexPath, indexText),
  };
}

/** Merge N overlapping records into one, archiving every original. */
export function planMerge(input: MergeInput): AdrCompositePlan {
  if (input.originals.length < 2) throw new Error("A merge must consolidate at least two records");
  const archives: AdrArchiveStep[] = [];
  let indexText = input.indexText;
  for (const original of input.originals) {
    const archived = archiveStep(original, [input.successor.number], input.indexPath, indexText);
    archives.push(archived.step);
    indexText = archived.indexText;
  }
  return {
    creates: [{ path: input.successor.path, text: input.successor.text }],
    archives,
    indexPath: input.indexPath,
    originalIndexText: input.indexText,
    indexText: addDraftBullets([input.successor], input.indexPath, indexText),
  };
}

/**
 * Absorb auxiliary amendments into one governing ADR. Unlike merge, absorb
 * mints no successor and never archives the governor.
 */
export function planAbsorb(input: AbsorbInput): AdrAbsorbPlan {
  const governingMatch = /^\.red\/adr\/(\d{4})-.+\.md$/.exec(input.governing.path);
  if (!governingMatch) throw new Error(`Governing ADR is not in the active lane: ${input.governing.path}`);
  if (input.rewrittenGoverningText === input.governing.text) {
    throw new Error("Absorb must rewrite the governing ADR with the accepted amendments");
  }
  if (input.auxiliaries.length < 1) throw new Error("Absorb must archive at least one auxiliary ADR");
  if (input.auxiliaries.some((auxiliary) => auxiliary.path === input.governing.path)) {
    throw new Error("The governing ADR cannot absorb itself");
  }

  const archives: AdrArchiveStep[] = [];
  let indexText = input.indexText;
  for (const auxiliary of input.auxiliaries) {
    const archived = archiveStep(auxiliary, [governingMatch[1]!], input.indexPath, indexText);
    archives.push(archived.step);
    indexText = archived.indexText;
  }
  return {
    governing: {
      path: input.governing.path,
      originalText: input.governing.text,
      text: input.rewrittenGoverningText,
    },
    archives,
    indexPath: input.indexPath,
    originalIndexText: input.indexText,
    indexText,
  };
}

/** Apply an absorb plan in dependency order, compensating every completed step on failure. */
export async function applyAbsorb(plan: AdrAbsorbPlan, io: AdrOperationIo): Promise<void> {
  let governingTouched = false;
  let indexTouched = false;
  const prepared: AdrArchiveStep[] = [];
  const moved: AdrArchiveStep[] = [];
  try {
    governingTouched = true;
    await io.fs.writeFile(plan.governing.path, plan.governing.text);
    for (const step of plan.archives) {
      prepared.push(step);
      await io.fs.writeFile(step.from, step.adrText);
      await io.git.mv(step.from, step.to);
      moved.push(step);
    }
    indexTouched = true;
    await io.fs.writeFile(plan.indexPath, plan.indexText);
  } catch (error) {
    if (indexTouched) await io.fs.writeFile(plan.indexPath, plan.originalIndexText);
    const movedPaths = new Set(moved.map((step) => step.from));
    for (const step of moved.reverse()) {
      await io.git.mv(step.to, step.from);
      await io.fs.writeFile(step.from, step.originalAdrText);
    }
    for (const step of prepared.reverse()) {
      if (!movedPaths.has(step.from)) await io.fs.writeFile(step.from, step.originalAdrText);
    }
    if (governingTouched) {
      await io.fs.writeFile(plan.governing.path, plan.governing.originalText);
    }
    throw error;
  }
}

/**
 * Apply a split or merge: mint the new records, archive the originals, then
 * write the INDEX once. Any failure rolls the completed steps back in reverse,
 * so the tree never keeps half a supersede-and-replace.
 */
export async function applyComposite(plan: AdrCompositePlan, io: AdrOperationIo): Promise<void> {
  const created: string[] = [];
  const moved: AdrArchiveStep[] = [];

  const rollback = async (): Promise<void> => {
    for (const step of moved.reverse()) {
      await io.git.mv(step.to, step.from);
      await io.fs.writeFile(step.from, step.originalAdrText);
    }
    if (io.fs.rm) for (const path of created.reverse()) await io.fs.rm(path);
  };

  try {
    for (const create of plan.creates) {
      await io.fs.writeFile(create.path, create.text);
      created.push(create.path);
    }
    for (const step of plan.archives) {
      await io.fs.writeFile(step.from, step.adrText);
      await io.git.mv(step.from, step.to);
      moved.push(step);
    }
    await io.fs.writeFile(plan.indexPath, plan.indexText);
  } catch (error) {
    await rollback();
    await io.fs.writeFile(plan.indexPath, plan.originalIndexText);
    throw error;
  }
}
