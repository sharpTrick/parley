/**
 * Turning a bad config into a message an operator can act on. A zod error stringifies as a JSON dump
 * of its issues, which names neither the file nor the shape expected — and the whole-file failure is
 * the first one an operator hits.
 */
import { z } from 'zod';

export const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** Render a validation failure as `<field path>: <message>` lines. */
export function issueLines(err: unknown): string {
  const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return `  ${messageOf(err)}`;
  return issues
    .map((i) => `  ${i.path.length === 0 ? '(document)' : i.path.join('.')}: ${i.message}`)
    .join('\n');
}

export function describeDocument(data: unknown): string {
  if (data === null || data === undefined) return 'empty (or holds only comments)';
  if (Array.isArray(data)) return 'a YAML sequence';
  return `a bare ${typeof data}`;
}

/**
 * A config value is only interpolated into the `parley-<name>` suggestion when it is a bare package
 * suffix. Keep this narrow, so that a generated or third-party config file cannot put its own text
 * inside a command the operator is being told to run.
 */
const BACKEND_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Reject a legacy `backend:` key rather than letting zod strip it, so that a config naming one
 * backend can never run a different one silently.
 */
export function assertNoBackendKey(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || !('backend' in raw)) return;
  const value = (raw as { backend: unknown }).backend;
  const named = typeof value === 'string' ? value.replace(/^local-/, '') : '';
  const suggestion = BACKEND_NAME.test(named)
    ? `parley-${named}`
    : 'parley-sqlite, parley-matrix, parley-redis, …';
  throw new Error(
    'config: `backend` is not a supported field. The backend is selected by which binary you run, ' +
      `not by config — run \`${suggestion}\` (each backend package ships its own bin). ` +
      'Remove `backend:` from the config file.',
  );
}

/**
 * Reject a retired `presence:` key rather than letting `.strict()` report it as an unrecognized
 * one, so that an operator upgrading from a release where it was default-on reads a removal instead
 * of a suspected typo. Carries the key's own path, so the rendered diagnostic names `presence`
 * rather than the whole document.
 */
export function assertNoPresenceKey(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || !('presence' in raw)) return;
  throw new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: ['presence'],
      message:
        'presence was removed: there is no roster, no heartbeat topic and no parley_list_users ' +
        'tool for it to configure. Delete the `presence:` block from the config file.',
    },
  ]);
}
