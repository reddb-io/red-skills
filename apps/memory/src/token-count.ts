import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Tiktoken } from "js-tiktoken/lite";

declare const __RED_LAZY_ASSET__: string;

type TokenizerAsset = {
  createCl100kEncoding(): Tiktoken;
};

type FullTokenizerPackage = {
  getEncoding(name: "cl100k_base"): Tiktoken;
};

const runtimeRequire = createRequire(import.meta.url);
let tokenizer: Tiktoken | undefined;

/** Count with the memory app's stable cl100k boundary, loading ranks on first use. */
export function countCl100kTokens(text: string): number {
  if (!text) return 0;
  tokenizer ??= loadTokenizer();
  return tokenizer.encode(text).length;
}

function loadTokenizer(): Tiktoken {
  if (typeof __RED_LAZY_ASSET__ === "string") {
    const assetPath = fileURLToPath(new URL(__RED_LAZY_ASSET__, import.meta.url));
    return (runtimeRequire(assetPath) as TokenizerAsset).createCl100kEncoding();
  }

  // Source/tests resolve the workspace dependency; shipped bundles take the
  // branch above and own the sibling asset instead of requiring node_modules.
  return (runtimeRequire("js-tiktoken") as FullTokenizerPackage).getEncoding("cl100k_base");
}
