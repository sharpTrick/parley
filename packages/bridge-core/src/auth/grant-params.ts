import type { Response } from 'express';
import {
  InvalidScopeError,
  InvalidTargetError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

export const DEFAULT_SCOPES_SUPPORTED = ['mcp'];

// Keep this filter, so that `scope=` or a doubled space cannot be refused as an unsupported scope
// whose name is the empty string — an error_description naming nothing, on a flow the client cannot
// recover from. RFC 6749 §3.3 spells a scope token `1*NQCHAR`: an empty one never names one.
export function namedScopes(scopes: string[]): string[] {
  return scopes.filter((s) => s.length > 0);
}

export function assertScopes(
  scopes: string[] | undefined,
  supported: string[] = DEFAULT_SCOPES_SUPPORTED,
): void {
  const unsupported = (scopes ?? []).filter((s) => !supported.includes(s));
  if (unsupported.length > 0) {
    throw new InvalidScopeError(
      `this server does not issue the scope(s) ${unsupported.join(' ')}; it supports ${supported.join(' ')}`,
    );
  }
}

export function assertResource(requested: URL | undefined, canonical: URL): void {
  if (requested !== undefined && requested.href !== canonical.href) {
    throw new InvalidTargetError(`this server only issues tokens for ${canonical.href}`);
  }
}

/**
 * Whether the client itself wrote `redirect_uri` on the authorization request. The SDK's handler
 * defaults `params.redirectUri` to the client's single registered URI when it was absent, so by the
 * time the provider sees the params the two cases are indistinguishable — and RFC 6749 §4.1.3 makes
 * the parameter REQUIRED at /token only in the first of them. Reading both containers keeps the
 * answer "supplied" whenever it might have been, which is the strict side.
 */
export function redirectUriWasSupplied(res: Response): boolean {
  const req = (res as { req?: { body?: unknown; query?: unknown } }).req;
  if (req === undefined) return true;
  const body = req.body as Record<string, unknown> | undefined;
  const query = req.query as Record<string, unknown> | undefined;
  return (body?.redirect_uri ?? query?.redirect_uri) !== undefined;
}
