export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** Where tokens live. The real implementation is expo-secure-store only (AGENTS.md rule 4). */
export interface TokenStore {
  read(): Promise<TokenPair | null>;
  write(tokens: TokenPair): Promise<void>;
  clear(): Promise<void>;
}

/** What the session screens will show after a local sign-out. A UI flag, not a source of truth. */
export type SignOutNotice = 'none' | 'session_ended' | 'revoke_unconfirmed';
