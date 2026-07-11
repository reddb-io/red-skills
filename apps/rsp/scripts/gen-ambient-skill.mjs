#!/usr/bin/env node
// Regenerate the committed ambient-instruction artifact from the rsp wrapper
// capability table. Run: pnpm --filter @reddb-io/rsp gen:ambient-skill
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { AMBIENT_SKILL_RELATIVE_PATH, renderAmbientSkill } = await import("../src/ambient-skill.ts");

const target = join(packageRoot, AMBIENT_SKILL_RELATIVE_PATH);
writeFileSync(target, renderAmbientSkill());
process.stdout.write(`wrote ${AMBIENT_SKILL_RELATIVE_PATH}\n`);
