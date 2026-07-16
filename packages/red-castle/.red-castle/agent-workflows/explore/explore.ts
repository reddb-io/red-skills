import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import {
  asRecord,
  asString,
  claudeAgent,
  fail,
  required,
  safeSh,
  standardSchema,
  writeText,
} from "../shared/common";
import { runWithExtraction } from "../shared/run-with-extraction";

interface ExploreOutput {
  readonly comment: string;
}

const exploreOutputSchema = standardSchema<ExploreOutput>((value) => {
  const record = asRecord(value, "explore output");
  return {
    comment: asString(record.comment, "comment"),
  };
});

const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");

try {
  const issueContext =
    safeSh(`gh issue view ${ISSUE_NUMBER} --comments`) ||
    `Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}`;

  const result = await runWithExtraction({
    name: `explore-#${ISSUE_NUMBER}`,
    agent: claudeAgent(),
    sandbox: noSandbox(),
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      ISSUE_NUMBER,
      ISSUE_TITLE,
      ISSUE_CONTEXT: issueContext,
    },
    output: sandcastle.Output.object({
      tag: "output",
      schema: exploreOutputSchema,
    }),
    extractionPrompt: fs.readFileSync(
      path.join(import.meta.dirname, "extraction.md"),
      "utf8",
    ),
  });

  writeText("comment.md", result.output.comment);

  console.log(`Exploration comment written for issue #${ISSUE_NUMBER}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
