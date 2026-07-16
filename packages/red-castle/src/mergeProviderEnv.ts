/**
 * Merge env vars from the env resolver, agent provider, and sandbox provider.
 *
 * Provider env (agent + sandbox) overrides env resolver output for shared keys.
 * Agent and sandbox provider env must NOT have overlapping keys — if they do,
 * this function throws.
 */
export const mergeProviderEnv = (options: {
  readonly resolvedEnv: Record<string, string>;
  readonly agentProviderEnv: Record<string, string>;
  readonly sandboxProviderEnv: Record<string, string>;
}): Record<string, string> => {
  const { resolvedEnv, agentProviderEnv, sandboxProviderEnv } = options;

  // Check for overlapping keys between agent and sandbox provider env
  const agentKeys = Object.keys(agentProviderEnv);
  const sandboxKeys = new Set(Object.keys(sandboxProviderEnv));
  const overlapping = agentKeys.filter((k) => sandboxKeys.has(k));

  if (overlapping.length > 0) {
    throw new Error(
      `Overlapping env keys between agent provider and sandbox provider: ${overlapping.join(", ")}`,
    );
  }

  return {
    ...resolvedEnv,
    ...sandboxProviderEnv,
    ...agentProviderEnv,
  };
};
