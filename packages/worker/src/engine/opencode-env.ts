export const OPENCODE_AUTH_ENV_PRECEDENCE = ["OPENAI_API_KEY", "MINIMAX_API_KEY", "OPENROUTER_API_KEY"] as const;

export type OpenCodeAuthEnvName = (typeof OPENCODE_AUTH_ENV_PRECEDENCE)[number];

export interface OpenCodeAuth {
  envVar: OpenCodeAuthEnvName;
  keyValue: string;
}

export function resolveOpenCodeAuth(env: NodeJS.ProcessEnv): OpenCodeAuth | undefined {
  for (const name of OPENCODE_AUTH_ENV_PRECEDENCE) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      return { envVar: name, keyValue: value };
    }
  }
  return undefined;
}

export function openCodeAuthEnv(auth: OpenCodeAuth | undefined): Record<string, string> | undefined {
  return auth ? { [auth.envVar]: auth.keyValue } : undefined;
}
