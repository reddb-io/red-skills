import { join } from "node:path";
import { localValue, type LocalOptions } from "./local.js";

export function render(options: LocalOptions): string {
  return join("fixture", localValue(options));
}
