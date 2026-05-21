export interface Session {
  token: string;
}

export type UserId = string;

export class TokenStore {
  rotate(): void {}
}

export function issueToken(user: UserId): string {
  return user;
}

export const verifyToken = (token: string) => token.length > 0;
