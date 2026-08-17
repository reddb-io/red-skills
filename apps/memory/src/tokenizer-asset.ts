import { Tiktoken } from "js-tiktoken/lite";
import cl100kBase from "js-tiktoken/ranks/cl100k_base";

/** Runtime entry for the package-owned tokenizer asset emitted beside the app bundle. */
export function createCl100kEncoding(): Tiktoken {
  return new Tiktoken(cl100kBase);
}
