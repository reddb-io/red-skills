import { CORE_MEMORY_OPERATIONS } from "./definitions-core.js";
import { DOC_MEMORY_OPERATIONS } from "./definitions-docs.js";
import { SYSTEM_MEMORY_OPERATIONS } from "./definitions-system.js";

export const READ_ONLY_MEMORY_OPERATION_DEFINITIONS = [
  ...CORE_MEMORY_OPERATIONS,
  ...DOC_MEMORY_OPERATIONS,
  ...SYSTEM_MEMORY_OPERATIONS,
] as const;
