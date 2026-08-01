import { delay, statusOf } from '@sharptrick/parley-net-util';
import type { BotApi } from './api.js';
import { describe, type Diagnostics } from './diagnostics.js';
import { canonicalChatKey, requireMessage, type TgMessage, type TgUpdate } from './wire.js';

/** Statuses that mean the token/URL itself is wrong — retrying can only make it worse. */
const FATAL_POLL_STATUSES = [401, 403, 404];

/** Floor on how fast {@link pollUpdates} may re-poll after an answer that acked nothing. */
const MIN_IDLE_POLL_MS = 250;

/**
 * The ONE shared `getUpdates` long-poll loop — Telegram allows exactly one consumer per bot token
 * (a second gets HTTP 409), so every subscription and every parked read is fed from here.
 * `offset` = last confirmed `update_id + 1` — Telegram's acknowledgement protocol. Each connect
 * starts at offset 0, replaying whatever backlog Telegram retained (~24h); the store's dedup makes
 * that replay harmless and doubles as offline catch-up. Accepts BOTH `update.message`
 * (groups/DMs) and `update.channel_post` (channels). Runs until `isCurrent()` goes false — the
 * connection it was started for was torn down — or a status arrives that retrying cannot heal.
 *
 * `deliver` answers whether the update was taken durably, or refused for a reason that can never
 * clear. Anything else — a `false`, or a throw out of the store write — ends the batch with
 * `offset` still BELOW that update, so Telegram redelivers it: the retained backlog is the only
 * redelivery this backend has, and the store is the only history it can ever produce.
 */
export async function pollUpdates(opts: {
  api: BotApi;
  timeoutS: number;
  diagnostics: Diagnostics;
  isCurrent: () => boolean;
  deliver: (chatId: string, msg: TgMessage) => boolean;
}): Promise<void> {
  const { api, timeoutS, diagnostics, isCurrent, deliver } = opts;
  let offset = 0;
  while (isCurrent()) {
    let updates: TgUpdate[];
    const startedAt = Date.now();
    try {
      // Budget = the long poll plus 40% slack, at least 2s. Keep a ceiling on it, so that a
      // connection accepted and never answered (idle NAT drop, hung proxy) cannot park the
      // single ingestion loop for the lifetime of the process.
      const budgetMs = timeoutS * 1000 + Math.max(2_000, timeoutS * 400);
      const result = await api.call('GET', `/getUpdates?timeout=${timeoutS}&offset=${offset}`, {
        budgetMs,
        abortOnDisconnect: true,
      });
      if (!Array.isArray(result)) {
        throw new Error('Telegram GET /getUpdates → result: not an array of updates');
      }
      updates = result as TgUpdate[];
    } catch (err) {
      if (!isCurrent()) break;
      const status = statusOf(err);
      // A rejected token or a wrong api_url never heals by retrying — surface it and stop,
      // so that the bridge is a loud failure instead of a silent black hole hammering the API.
      if (status !== undefined && FATAL_POLL_STATUSES.includes(status)) {
        diagnostics.report(`getUpdates failed fatally, ingestion stopped: ${describe(err)}`);
        return;
      }
      // 409 Conflict = getUpdates is unavailable for this token: either another poller holds
      // it (Telegram allows exactly one) or a webhook is registered (call deleteWebhook).
      // Telegram's own description says which — it rides along in the error text.
      const conflict = status === 409;
      diagnostics.report(`getUpdates failed, retrying: ${describe(err)}`, 'poll-failure');
      await delay(conflict ? 3000 : 500);
      continue;
    }
    if (!isCurrent()) break;
    const ackedBefore = offset;
    for (const u of updates) {
      const msg = u?.message ?? u?.channel_post;
      const label = `Telegram GET /getUpdates → update ${String(u.update_id)}`;
      let carried: { chatId: string; message: TgMessage } | undefined;
      if (msg !== undefined) {
        try {
          const message = requireMessage(label, msg);
          carried = { chatId: canonicalChatKey(label, message.chat.id), message };
        } catch (err) {
          // An update this bridge can never READ is dropped and acknowledged: holding one back
          // would stall the loop forever on a batch nothing downstream can ever be given.
          diagnostics.report(`dropped update ${u.update_id}: ${describe(err)}`, 'ingest');
        }
      }
      if (carried !== undefined) {
        let held: string | undefined;
        try {
          if (!deliver(carried.chatId, carried.message)) {
            held = 'the observed-message store has no append descriptor';
          }
        } catch (err) {
          held = describe(err);
        }
        if (held !== undefined) {
          // Keep the loop alive across a failing store write (ENOSPC/EIO) AND keep the update
          // unacknowledged, so that Telegram serves it again once the store can take it.
          diagnostics.report(`holding update ${u.update_id} unacknowledged: ${held}`, 'ingest-hold');
          break;
        }
      }
      // Acknowledge only an update stating an id in the domain this arithmetic is defined on.
      // `Math.max(offset, NaN)` is NaN, which is below nothing, so one id-less update from a
      // non-conforming upstream would poison the offset for the life of the loop and re-serve
      // the whole backlog forever; an id outside the safe-integer range poisons it the other
      // way, acknowledging updates that never arrived and going deaf to every later one.
      if (typeof u?.update_id === 'number' && Number.isSafeInteger(u.update_id)) {
        offset = Math.max(offset, u.update_id + 1);
      }
    }
    // Keep a floor under an iteration that made NO PROGRESS, so that an upstream ignoring
    // `timeout` OR ignoring `offset` (a proxy, a local Bot API server) cannot turn the single
    // ingestion path into a request flood against the operator's bot token. Keying this on the
    // acknowledgement rather than on the answer being empty, so that a batch re-served forever is
    // throttled too — every record in it dedups, so nothing else would ever make it visible.
    if (offset === ackedBefore) {
      const idle = Date.now() - startedAt;
      if (idle < MIN_IDLE_POLL_MS) await delay(MIN_IDLE_POLL_MS - idle);
    }
  }
}
