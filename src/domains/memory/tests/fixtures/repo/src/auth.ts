export interface Session {
  token: string;
}

export type UserId = string;

export class TokenStore {
  rotate(): void {}
}

export function issueToken(user: UserId): string {
  const token = String(user);
  return verifyToken(token) ? token : "";
}

export const verifyToken = (token: string) => token.length > 0;
