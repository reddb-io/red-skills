#!/usr/bin/env node
import { main } from './cli/entry.js';

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

export {};
