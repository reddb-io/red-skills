import { join } from "node:path";
import { localValue } from "./local.js";

export function render(): string {
  return join("fixture", localValue);
}
