import { AccountEpoch } from './auth/epoch';
import type { TokenPair, TokenStore } from './auth/types';
import { createApiClient, type ApiClientDeps } from './api/client';
import type { LogFields, Logger } from './api/errors';

/** Test helpers only (not imported by the app). */

export interface MemoryTokens extends TokenStore {
  current(): TokenPair | null;
  writes: TokenPair[];
  failWrites: boolean;
}

export function memoryTokens(initial: TokenPair | null): MemoryTokens {
  let value = initial;
  const store: MemoryTokens = {
    writes: [],
    failWrites: false,
    current: () => value,
    read: async () => value,
    write: async (tokens) => {
      if (store.failWrites) throw new Error('secure-store write failed');
      store.writes.push(tokens);
      value = tokens;
    },
    clear: async () => {
      value = null;
    },
  };
  return store;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export const session = (accessToken: string, refreshToken: string) => ({
  session: { accessToken, accessTokenExpiresAt: '2030-01-01T00:00:00.000Z', refreshToken },
});

export interface Call {
  path: string;
  /** The query string with its `?` (empty when there is none). */
  search: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

export type Handler = (call: Call, init: RequestInit) => Response | Promise<Response>;

export function makeHarness(options: {
  handler: Handler;
  tokens?: TokenPair | null;
  online?: () => boolean;
  timeoutMs?: number;
}) {
  const epoch = new AccountEpoch();
  const tokens = memoryTokens(options.tokens === undefined ? { accessToken: 'old', refreshToken: 'r1' } : options.tokens);
  const calls: Call[] = [];
  const invalidated: string[] = [];
  const warnings: Array<{ event: string; fields: LogFields }> = [];
  const logger: Logger = { warn: (event, fields) => warnings.push({ event, fields: fields ?? {} }) };

  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const call: Call = {
      path: url.pathname,
      search: url.search,
      method: init.method ?? 'GET',
      authorization: headers.get('Authorization'),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    return options.handler(call, init);
  };

  const deps: ApiClientDeps = {
    baseUrl: 'https://api.test',
    fetch: fakeFetch,
    tokens,
    epoch,
    isOnline: options.online ?? (() => true),
    onSessionInvalid: async (reason) => {
      invalidated.push(reason);
    },
    timeoutMs: options.timeoutMs,
    logger,
  };
  const client = createApiClient(deps);
  return {
    client,
    epoch,
    tokens,
    calls,
    invalidated,
    warnings,
    refreshCalls: () => calls.filter((c) => c.path === '/auth/refresh').length,
  };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
