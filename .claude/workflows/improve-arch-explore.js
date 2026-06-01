// DOGFOOD REFERENCE — repo-local, not shipped. Plugins cannot bundle workflows, so this
// file works only inside the RedSkills repo. It lives in .claude/workflows/ (carved out of
// the .claude/ gitignore) so it is BOTH committed for contributors AND saved as the
// /improve-arch-explore command. It is the reference implementation for the OPTIONAL workflow
// acceleration described in plugins/dev/skills/engineering/improve-codebase-architecture/SKILL.md
// (step 1). In any other repo the skill authors the equivalent inline; the Agent-tool path is
// the baseline that works with no workflow support at all.
export const meta = {
  name: 'improve-arch-explore',
  description: 'Fan-out the Explore phase of /improve-codebase-architecture across 4 architecture lenses, then adversarially refute the pooled deepening candidates with the deletion test before returning the vetted list. Minimal profile: 4 explore + 1 consolidated vet agent.',
  phases: [
    { title: 'Explore', detail: 'one Explore agent per architecture lens, read-only, top-2 each' },
    { title: 'Vet', detail: 'single adversarial reviewer over all pooled candidates' },
  ],
}

// Target dir comes from args; default to the AFK TS core for the pilot.
const TARGET = (typeof args === 'string' && args.trim()) ? args.trim() : 'src/domains/dev/src/core'

// Shared vocabulary block — inlined so every agent speaks the same language
// (mirrors plugins/dev/skills/engineering/improve-codebase-architecture/LANGUAGE.md).
const GLOSSARY = `
ARCHITECTURE VOCABULARY — use these terms exactly:
- Module: anything with an interface and an implementation.
- Interface: everything a caller must know — types, invariants, error modes, ordering, config. Not just the type signature.
- Depth: leverage at the interface — a lot of behaviour behind a small interface. Deep = high leverage. Shallow = interface nearly as complex as the implementation.
- Seam: where an interface lives; a place behaviour can be altered without editing in place. (Use "seam", never "boundary".)
- Locality: change, bugs, and knowledge concentrated in one place.
DELETION TEST: imagine deleting the module. If complexity vanishes, it was a pass-through (shallow). If complexity REAPPEARS, concentrated across N callers, it was earning its keep (a real seam worth deepening).
Before proposing, read .red/CONTEXT.md (domain glossary) and .red/adr/ — use the project's domain nouns, and do NOT re-litigate decisions an ADR already settled.`

const LENSES = [
  {
    key: 'shallow-modules',
    question: 'Where are modules SHALLOW — the interface nearly as complex as the implementation? Pass-throughs, thin wrappers, modules that exist only to forward calls.',
  },
  {
    key: 'concept-scatter',
    question: 'Where does understanding ONE concept require bouncing between many small modules? Logic that should have locality but is smeared across files.',
  },
  {
    key: 'testability',
    question: 'Where have pure functions been extracted just for testability, but the real bugs hide in HOW they are called (no locality)? Which parts are untested or hard to test through their current interface?',
  },
  {
    key: 'seam-leakage',
    question: 'Where do tightly-coupled modules LEAK across their seams — internals exposed, callers depending on implementation details, a seam that is not really a seam?',
  },
]

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    candidates: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'short name for the deepening opportunity' },
          files: { type: 'array', items: { type: 'string' }, description: 'files/modules involved' },
          problem: { type: 'string', description: 'why the current architecture causes friction' },
          solution: { type: 'string', description: 'plain-English description of what would change' },
          deletionTest: { type: 'string', description: 'prediction: would deleting this module concentrate complexity (real seam) or just move it (pass-through)?' },
        },
        required: ['title', 'files', 'problem', 'solution', 'deletionTest'],
      },
    },
  },
  required: ['candidates'],
}

// Polarity is explicit: worthDeepening=true means the REFACTOR holds up — the
// candidate survived refutation and is worth taking to the human. worthDeepening=false
// means the adversary refuted it (the module is already a real seam, leave it alone).
const VET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'must match the candidate title verbatim' },
          worthDeepening: { type: 'boolean', description: 'TRUE only if the proposed refactor survives your refutation. FALSE if the module is already a real seam / an ADR settles it / the friction is not real.' },
          reasoning: { type: 'string', description: 'one paragraph: did deleting the module concentrate complexity (refactor holds) or merely move it (refuted)?' },
        },
        required: ['title', 'worthDeepening', 'reasoning'],
      },
    },
  },
  required: ['verdicts'],
}

// Phase 1 — barrier: all 4 lenses explore in parallel (top-2 each), then pool.
const lensResults = await parallel(
  LENSES.map((lens) => () => agent(
    `${GLOSSARY}\n\nYou are exploring ONLY the directory \`${TARGET}\` (read-only). LENS: ${lens.question}\n\nWalk the code organically — do not follow rigid heuristics. Apply the deletion test yourself BEFORE surfacing anything, and return ONLY your strongest deepening opportunities that you believe would survive an adversarial deletion-test review (AT MOST 2). Quality over quantity — return fewer, or none, rather than weak candidates. Do NOT propose interfaces or write code.`,
    { label: `explore:${lens.key}`, phase: 'Explore', agentType: 'Explore', schema: CANDIDATE_SCHEMA },
  ).then((r) => ({ lens: lens.key, candidates: r?.candidates ?? [] })))
)

const pooled = lensResults.filter(Boolean).flatMap((r) => r.candidates.map((c) => ({ ...c, lens: r.lens })))

// Phase 2 — a SINGLE adversarial reviewer vets every pooled candidate in one pass.
let verdicts = []
if (pooled.length > 0) {
  const block = pooled.map((c, i) =>
    `CANDIDATE ${i + 1} [lens: ${c.lens}]\nTitle: ${c.title}\nFiles: ${c.files.join(', ')}\nProblem: ${c.problem}\nProposed solution: ${c.solution}\nTheir deletion-test claim: ${c.deletionTest}`
  ).join('\n\n')
  const v = await agent(
    `${GLOSSARY}\n\nADVERSARIAL REVIEW of ${pooled.length} deepening candidates in \`${TARGET}\`, pooled from four exploration lenses. Read the actual files. For EACH candidate, try to REFUTE it: argue that deleting/merging the modules would merely MOVE complexity rather than concentrate it, or that an ADR already settles it, or that the friction is not real. Several candidates may target the same module from different angles — treat each on its own merits but note overlaps. Set worthDeepening=true ONLY when the refactor genuinely withstands your refutation; default to false when uncertain. Return one verdict per candidate, title matching verbatim.\n\n${block}`,
    { label: 'vet:pooled', phase: 'Vet', agentType: 'Explore', schema: VET_SCHEMA },
  )
  verdicts = v?.verdicts ?? []
}

const all = pooled.map((c) => {
  const v = verdicts.find((x) => x.title === c.title)
  return { ...c, worthDeepening: !!v?.worthDeepening, reasoning: v?.reasoning ?? 'no verdict returned' }
})
const survived = all.filter((c) => c.worthDeepening)

log(`Explored ${LENSES.length} lenses over ${TARGET}: ${all.length} candidates, ${survived.length} survived adversarial deletion-test.`)

return {
  target: TARGET,
  total: all.length,
  survived: survived.length,
  candidates: survived,
  refuted: all.filter((c) => !c.worthDeepening).map((c) => ({ title: c.title, lens: c.lens, reason: c.reasoning })),
}
