export interface Session {
  id: string;
}

export function issueSession(id: string): Session {
  return { id };
}
