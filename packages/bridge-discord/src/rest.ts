import { fetchWithRetry, retryAfterFromHeader } from '@sharptrick/parley-net-util';
import { readFileSync } from 'node:fs';

const DEFAULT_API_URL = 'https://discord.com/api/v10';

/** This package's published version — the release pipeline stamps `package.json`, never source. */
const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/**
 * Discord documents a request without a valid `DiscordBot ($url, $version)` User-Agent as one that
 * "may be blocked". Keep the version read from the manifest, so a release cannot ship a stale one.
 */
const USER_AGENT = `DiscordBot (https://github.com/sharpTrick/parley, ${VERSION})`;

/**
 * Single HTTP entry point: `Authorization: Bot <token>`, the required {@link USER_AGENT}, JSON
 * encoding, and net-util's 429 retry. Keep retries behind `isStopped`, so that a disconnected
 * bridge never leaves a loop hammering the API. Throws on unexpected non-2xx.
 */
export class DiscordRest {
  private apiUrl = DEFAULT_API_URL;
  private token?: string;

  constructor(private readonly isStopped: () => boolean) {}

  configure(apiUrl: string | undefined, token: string | undefined): void {
    this.apiUrl = (apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.token = token;
  }

  async request(
    method: string,
    path: string,
    opts?: { body?: unknown; allowStatuses?: number[]; deadlineMs?: number },
  ): Promise<Response> {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
    if (this.token !== undefined) headers.Authorization = `Bot ${this.token}`;
    if (opts?.body !== undefined) headers['Content-Type'] = 'application/json';

    return fetchWithRetry(
      `${this.apiUrl}${path}`,
      {
        method,
        headers,
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
      },
      {
        label: `Discord ${method} ${path}`,
        isStopped: this.isStopped,
        retryAfterOf: readRetryAfter,
        allowStatuses: opts?.allowStatuses,
        deadlineMs: opts?.deadlineMs,
      },
    );
  }
}

/**
 * Discord's 429 hint: the standard `Retry-After` header, else Discord's own `retry_after` body
 * field (SECONDS, float). Return it UNCLAMPED, so that we never retry sooner than Discord asked —
 * that is what escalates a rate limit into a ban.
 */
async function readRetryAfter(res: Response): Promise<number | undefined> {
  const header = retryAfterFromHeader(res);
  if (header !== undefined) return header;
  try {
    const json = (await res.clone().json()) as { retry_after?: number };
    const seconds = json.retry_after;
    return typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}
