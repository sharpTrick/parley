import { NoSuchTopicError, type Topic } from '@sharptrick/parley-core';

export const DEFAULT_API_URL = 'https://slack.com/api';

/**
 * Objects asked for per `conversations.history` page. Slack caps this per rate-limit tier — 1000 for
 * an internal customer-built app, 15 for a commercially distributed non-Marketplace one — and serves
 * fewer than asked without saying so, so keep every window decision driven by what a page actually
 * CONTAINED rather than by this figure.
 */
export const HISTORY_PAGE_LIMIT = 200;

/**
 * Hard ceiling on the pages one `conversations.history` walk may request. Keep this a THROW rather
 * than a break, so that a truncated walk can never publish a `nextCursor` above history it never
 * read — that span sits below the cursor and no later catch-up would revisit it.
 */
export const MAX_HISTORY_PAGES = 2_000;

/** `messages` is deliberately `unknown`: an `ok:true` body is vendor-controlled, not a contract. */
export interface HistoryResponse {
  ok: boolean;
  messages?: unknown;
  response_metadata?: { next_cursor?: string };
}

export interface AuthTestResponse {
  ok: boolean;
  user?: string;
  user_id?: string;
}

/** An `ok:false` Web API response, carrying Slack's machine-readable `error` code. */
export class SlackApiError extends Error {
  constructor(
    method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} → ${code}`);
    this.name = 'SlackApiError';
  }
}

/**
 * A 200 carrying `ok:true` that is not the shape the method documents — `ok:true` is a claim about
 * the CALL, not about the body, and every field read out of one reaches either the seam or the
 * wire. Keep the method in the message, so that a failure repeating on every catch-up names the
 * call that caused it instead of surfacing as an engine-level `TypeError` inside the plugin.
 */
export class SlackShapeError extends Error {
  constructor(method: string, detail: string) {
    super(`Slack ${method} → ${detail}`);
    this.name = 'SlackShapeError';
  }
}

/**
 * Slack error codes that mean "this conversation is not there for us" — the seam's absent-topic
 * contract ({@link NoSuchTopicError}). `not_in_channel` is absence for a READ (we cannot see the
 * channel's history); for a WRITE it is a live misconfiguration and must surface as a real error.
 */
export const ABSENT_ON_READ = ['channel_not_found', 'not_in_channel'];
export const ABSENT_ON_WRITE = ['channel_not_found'];

export const asSeamError =
  (topic: Topic, absentCodes: string[]) =>
  (e: unknown): never => {
    throw e instanceof SlackApiError && absentCodes.includes(e.code)
      ? new NoSuchTopicError(topic)
      : e;
  };
