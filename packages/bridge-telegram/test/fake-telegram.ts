import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * In-process fake Telegram Bot API (node:http, port 0) — just enough surface for the plugin:
 * `sendMessage`, `getUpdates` (with real long-poll parking + `offset` acknowledgement
 * semantics), `getMe`, and `getChat` (username → numeric-id resolution).
 *
 * Faithful in the ways that matter to the seam:
 *  - `message_id` is a PER-CHAT counter (so the composite `<chat>:<mid>` dedup key and the
 *    per-topic numeric cursor are exercised for real), `update_id` a global one.
 *  - `chat.id` is a NUMBER on both `sendMessage` responses and injected updates (mirroring real
 *    Telegram), and `@channelusername` references resolve to a stable numeric id via `getChat` —
 *    exactly the shape topic-to-chat routing needs (a string echo would mask it). The spelling is
 *    overridable ({@link FakeTelegram.spellChatId}) because it is the one key the client cannot
 *    choose, and a fake that can only echo the canonical number makes every disagreement between
 *    the id a topic resolved to and the id an upstream stamped unreachable from the suite.
 *  - a `chat_id` that is neither numeric nor `@channelusername` is REJECTED with 400 ("chat not
 *    found"), and an unknown token with 401, as the real API does. Keep both, so that the
 *    conformance suite cannot pass on topics real Telegram would refuse.
 *  - a poll at `offset` CONFIRMS and DELETES every update below it, as the real API does — a
 *    bridge that never advances its offset therefore re-reads a growing backlog forever here
 *    too, instead of looking indistinguishable from a healthy one. An update whose `update_id` this
 *    fake cannot order ({@link FakeTelegram.injectMalformedUpdate}) is neither confirmed nor
 *    skipped, so it is re-served on every poll — the shape a rewriting middlebox produces, and the
 *    only one under which a client's acknowledgement guard has anything to do.
 *  - `sendMessage` does NOT enqueue the bot's own message as an update — mirrors real
 *    Telegram (a bot never sees its own sends via getUpdates), which forces the plugin's
 *    record-own-post-from-the-response path.
 */
export interface FakeTelegram {
  /** Base URL to hand the plugin as `api_url`. */
  url: string;
  /** The only token this fake accepts; any other gets 401. */
  token: string;
  /** Shut down: answer parked polls, drop connections, close the listener. */
  close(): Promise<void>;
  /**
   * Simulate a HUMAN (non-bot) message arriving in `chatId` (a numeric id or `@name`, resolved
   * to the same numeric id sendMessage/getChat use): allocates the next per-chat message_id,
   * enqueues an update, and wakes parked long-polls. Returns the minted message_id.
   */
  injectUserMessage(chatId: string, from: string, text: string): number;
  /**
   * Like {@link injectUserMessage} but for an arbitrary `Message` shape — a captioned photo, a
   * sticker, a service message — so the plugin's normalization is exercised beyond plain text.
   * `as` selects the update field the message rides in: `message` (groups/DMs, the default) or
   * `channel_post` (channels, which carry no `from`).
   */
  injectRaw(chatId: string, payload: Record<string, unknown>, as?: 'message' | 'channel_post'): number;
  /**
   * Enqueue an update carrying no message this bridge reads (an edit, a reaction, a poll answer).
   * Real Telegram still expects it to be ACKNOWLEDGED — a loop that only advances `offset` for the
   * kinds it carries re-reads such a batch forever. Returns its `update_id`.
   */
  injectRawUpdate(payload: Record<string, unknown>): number;
  /**
   * Enqueue an update EXACTLY as given — including a non-conforming `update_id` (absent, a string,
   * out of range). `offset` is the only acknowledgement this protocol has and its sole input is a
   * field a middlebox or a local Bot API server can get wrong, so a fake that always stamps a valid
   * one leaves the plugin's guard against that with no reachable failing input.
   */
  injectMalformedUpdate(payload: Record<string, unknown>): void;
  /**
   * Like {@link injectUserMessage} but mints the message_id NOW (so it can be LOWER than a post
   * that runs next) while WITHHOLDING the update from getUpdates until `release()` — reproduces
   * the own-post race (a foreign message accepted before our post, delivered to the bridge after).
   */
  injectUserMessageDeferred(
    chatId: string,
    from: string,
    text: string,
  ): { messageId: number; release(): void };
  /** Fail every subsequent call to `method` with `status` (and Telegram's description), or clear it. */
  failMethod(method: string, failure: Failure | undefined): void;
  /**
   * Park every call to `method` until the returned handle is released — the only way to place a
   * lifecycle call (disconnect, a second connect) INSIDE a specific await of `connect`.
   */
  holdMethod(method: string): { release(): void };
  /**
   * Break `method` at the TRANSPORT layer rather than with a status: the request is accepted and
   * then never answered / half-answered / cut mid-body. A client with no request timeout parks
   * forever on all three, which no status-level failure can reproduce.
   */
  stallMethod(method: string, mode: StallMode | undefined): void;
  /**
   * Answer every `getUpdates` immediately, ignoring the `timeout` the client asked for — what a
   * proxy or a local Bot API server that does not implement long polling does. The only way to
   * see whether the ingestion loop has a floor under it, or spins at the speed of the network.
   */
  ignoreLongPoll(on: boolean): void;
  /**
   * Stop honouring `offset`: never confirm, never delete, and re-serve the whole backlog on every
   * poll — a caching proxy or a Bot API server that does not implement the acknowledgement half.
   * The client's offset then never advances, so the loop keeps getting a NON-EMPTY answer with no
   * progress in it, which the empty-answer shape cannot reproduce.
   */
  ignoreOffset(on: boolean): void;
  /**
   * Answer every call to `method` with HTTP 200 and exactly this body. A 2xx says nothing about
   * success on this API — `ok` does — so a middlebox, a captive portal or a non-conforming local
   * Bot API server can hand back a well-formed HTTP success carrying a refusal, a missing `result`
   * or no JSON at all, which no status-level failure can reproduce.
   */
  malformMethod(method: string, body: string | undefined): void;
  /**
   * Stamp `chat.id` with `spell(id)` instead of the canonical number, on every object this fake
   * builds a chat for — `sendMessage` responses, injected updates and `getChat`. The chat id is the
   * key every index in the plugin is built on and the ONE field the client cannot choose the
   * spelling of, so a fake that can only echo the canonical number leaves the whole
   * key-agreement class (a numeric string, a leading zero, a redirect, an id JSON rounds past
   * `MAX_SAFE_INTEGER`) unreachable from the suite. `undefined` restores the canonical number.
   */
  spellChatId(spell: ((id: number) => number | string) | undefined): void;
  /** How many requests this fake has served for `method` — the poll loop's retry cadence. */
  callCount(method: string): number;
  /**
   * `Date.now()` of every request received for `method`, in order. The gap between consecutive
   * entries IS the backoff the client applied — measured at the server, so it grades the retry
   * knobs a plugin passes to net-util rather than any single parsing function.
   */
  callTimes(method: string): number[];
  /**
   * The `offset` query value of every `getUpdates` received, VERBATIM. The acknowledgement protocol
   * is a number the client computes from an upstream-controlled field, so the spelling it puts on
   * the wire (`NaN`, `1e+21`, `2.5`) is the only place a poisoned offset is visible before the
   * bridge silently goes deaf.
   */
  pollOffsets(): string[];
  /** Long-polls currently parked. Drops to 0 when the client aborts them (plugin disconnect). */
  parkedPolls(): number;
  /** Updates still retained: real Telegram DROPS everything the client has acknowledged. */
  retainedUpdates(): number;
  /** Every `sendMessage` body received, in order. */
  readonly sent: Record<string, unknown>[];
}

/**
 * A failure to inject. Telegram states a 429's wait in BOTH the standard `Retry-After` header
 * (seconds) and `parameters.retry_after` (seconds) in the JSON body, independently — a fake that
 * can only emit one of them cannot grade which one a client prefers.
 */
export interface Failure {
  status: number;
  description: string;
  /** `Retry-After` response header, in SECONDS. */
  retryAfterHeader?: number;
  /** `parameters.retry_after` body field, in SECONDS. */
  retryAfterBody?: number;
  /** Fail only this many calls, then serve normally. Default: every call. */
  times?: number;
}

/** The bot behind {@link FakeTelegram.token} — what `getMe` answers. */
export const BOT_IDENTITY = { id: 999_000_001, username: 'parley_test_bot' };

/** How {@link FakeTelegram.stallMethod} breaks a request. */
export type StallMode = 'never-answer' | 'half-body' | 'close-mid-body';

interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number | string; type: string; username?: string };
  from?: { id: number; is_bot: boolean; username?: string; first_name: string };
  text?: string;
  reply_to_message?: { message_id: number };
  [key: string]: unknown;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
}

interface ParkedPoll {
  offset: number;
  res: ServerResponse;
  timer: NodeJS.Timeout;
}

const BOT = { ...BOT_IDENTITY, is_bot: true, first_name: 'Parley' };
/**
 * Shaped like a real @BotFather token (`<bot id>:<secret>`), so that the COLON is exercised: it is
 * what makes the token's percent-encoded spelling differ from its raw one, and a diagnostic can
 * echo either. A token of plain word characters cannot tell the two apart.
 */
const TOKEN = '8114253900:AAHfake-Bot-Token_For_Tests_0123456789';

/**
 * A known channel: its `@channelusername` resolves (via getChat) to this NUMERIC id, so tests
 * can drive `@name` chat_map/topic → numeric inbound `chat.id` routing.
 */
export const KNOWN_CHANNEL = { username: '@mychannel', id: -1_001_234_567_890 };

/** What real Telegram accepts as a `chat_id`: a numeric id or `@channelusername`. */
const VALID_CHAT_REF = /^(-?\d+|@[A-Za-z][A-Za-z0-9_]{3,31})$/;

export async function startFakeTelegram(): Promise<FakeTelegram> {
  /** Next message_id PER CHAT (keyed by numeric-id string) — unique only within a chat. */
  const nextMid = new Map<string, number>();
  /** `@name` → numeric id (getChat resolutions). */
  const knownByUsername = new Map<string, number>([[KNOWN_CHANNEL.username, KNOWN_CHANNEL.id]]);
  /** Stable synthetic numeric ids for `@name` chats tests have not pre-registered. */
  const syntheticIds = new Map<string, number>();
  let nextSynthetic = -1_005_000_000_001;

  /** Resolve a VALID chat_id reference (`@name` or numeric) to a stable number. */
  const numericChatId = (raw: string): number => {
    const known = knownByUsername.get(raw);
    if (known !== undefined) return known;
    if (/^-?\d+$/.test(raw)) return Number(raw);
    let id = syntheticIds.get(raw);
    if (id === undefined) {
      id = nextSynthetic--;
      syntheticIds.set(raw, id);
    }
    return id;
  };

  /** How `chat.id` is spelled on the wire — see {@link FakeTelegram.spellChatId}. */
  let spellChatId: ((id: number) => number | string) | undefined;

  /** The `chat` object real Telegram would stamp for `raw` (channels carry a `username`). */
  const buildChat = (raw: string, canonical: number): TgMessage['chat'] => {
    const id = spellChatId === undefined ? canonical : spellChatId(canonical);
    return raw.startsWith('@') ? { id, type: 'channel', username: raw.slice(1) } : { id, type: 'group' };
  };
  /** Global update_id counter. */
  let updateSeq = 1;
  /** Every update ever produced; `offset` filtering serves the acknowledged tail. */
  const updates: TgUpdate[] = [];
  /** Long-polls parked until an update they can see arrives (or their timeout lapses). */
  const parked = new Set<ParkedPoll>();
  const failures = new Map<string, Failure>();
  const stalls = new Map<string, StallMode>();
  const malformed = new Map<string, string>();
  let longPollHonoured = true;
  let offsetHonoured = true;
  const holds = new Map<string, { promise: Promise<void>; release(): void }>();
  /** Responses deliberately left hanging — closed on shutdown so the process can exit. */
  const stalled = new Set<ServerResponse>();
  const calls = new Map<string, number>();
  const times = new Map<string, number[]>();
  const sent: Record<string, unknown>[] = [];
  const offsetsSeen: string[] = [];

  const mintMid = (chatId: string): number => {
    const mid = nextMid.get(chatId) ?? 1;
    nextMid.set(chatId, mid + 1);
    return mid;
  };

  /**
   * Whether this fake can place an update in the `offset` ordering at all. One carrying a
   * non-conforming `update_id` ({@link FakeTelegram.injectMalformedUpdate}) can be neither served
   * in order nor confirmed, so it is re-served on every poll — which is what an injecting middlebox
   * or a broken local Bot API server looks like from the client, and the only shape under which the
   * client's own acknowledgement guard has anything to do.
   */
  const orderable = (u: TgUpdate): boolean =>
    Number.isSafeInteger(u.update_id) && u.update_id >= 0;

  const pending = (offset: number): TgUpdate[] =>
    offsetHonoured ? updates.filter((u) => !orderable(u) || u.update_id >= offset) : [...updates];

  /**
   * Real Telegram treats a poll at `offset` as confirmation of everything below it and DELETES
   * those updates. Keep that, so that a bridge which never advances its offset is visible as an
   * ever-growing backlog re-served on every poll instead of looking identical to a healthy one.
   */
  const confirm = (offset: number): void => {
    if (!offsetHonoured || offset <= 0) return;
    for (let i = updates.length - 1; i >= 0; i--) {
      const update = updates[i];
      if (update !== undefined && orderable(update) && update.update_id < offset) {
        updates.splice(i, 1);
      }
    }
  };

  /** Break a request at the transport layer (see {@link FakeTelegram.stallMethod}). */
  const stall = (res: ServerResponse, mode: StallMode): void => {
    stalled.add(res);
    if (mode === 'never-answer') return;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '4096' });
    res.write('{"ok":true,"resu');
    if (mode === 'close-mid-body') res.socket?.destroy();
  };

  const reply = (
    res: ServerResponse,
    status: number,
    payload: unknown,
    headers: Record<string, string> = {},
  ): void => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  };

  const answerPoll = (poll: ParkedPoll): void => {
    clearTimeout(poll.timer);
    parked.delete(poll);
    reply(poll.res, 200, { ok: true, result: pending(poll.offset) });
  };

  const wakeParked = (): void => {
    for (const poll of [...parked]) {
      if (pending(poll.offset).length > 0) answerPoll(poll);
    }
  };

  const enqueue = (chatId: string, payload: Record<string, unknown>): TgMessage => {
    const id = numericChatId(chatId);
    return {
      message_id: mintMid(String(id)),
      date: Math.floor(Date.now() / 1000),
      chat: buildChat(chatId, id),
      ...payload,
    };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (match === null) {
      reply(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
      return;
    }
    if (match[1] !== TOKEN) {
      reply(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
      return;
    }
    const method = match[2] ?? '';
    calls.set(method, (calls.get(method) ?? 0) + 1);
    times.set(method, [...(times.get(method) ?? []), Date.now()]);
    const stallMode = stalls.get(method);
    if (stallMode !== undefined) {
      stall(res, stallMode);
      return;
    }
    const malformedBody = malformed.get(method);
    if (malformedBody !== undefined) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(malformedBody);
      return;
    }
    const failure = failures.get(method);
    if (failure !== undefined) {
      if (failure.times !== undefined) {
        if (failure.times <= 1) failures.delete(method);
        else failures.set(method, { ...failure, times: failure.times - 1 });
      }
      const body: Record<string, unknown> = {
        ok: false,
        error_code: failure.status,
        description: failure.description,
      };
      if (failure.retryAfterBody !== undefined) {
        body.parameters = { retry_after: failure.retryAfterBody };
      }
      const headers =
        failure.retryAfterHeader === undefined
          ? {}
          : { 'Retry-After': String(failure.retryAfterHeader) };
      reply(res, failure.status, body, headers);
      return;
    }
    const hold = holds.get(method);
    if (hold !== undefined) await hold.promise;
    const body = await readJsonBody(req);
    const chatRef = (): string | undefined => {
      const raw = String(url.searchParams.get('chat_id') ?? body.chat_id ?? '');
      if (VALID_CHAT_REF.test(raw)) return raw;
      reply(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
      return undefined;
    };

    switch (method) {
      case 'getMe': {
        reply(res, 200, { ok: true, result: BOT });
        return;
      }
      case 'getChat': {
        const raw = chatRef();
        if (raw === undefined) return;
        reply(res, 200, { ok: true, result: buildChat(raw, numericChatId(raw)) });
        return;
      }
      case 'sendMessage': {
        const raw = chatRef();
        if (raw === undefined) return;
        sent.push(body);
        const message = enqueue(raw, { from: BOT, text: String(body.text ?? '') });
        if (typeof body.reply_to_message_id === 'number') {
          message.reply_to_message = { message_id: body.reply_to_message_id };
        }
        // Faithfully do NOT enqueue own-bot messages as updates (see module doc).
        reply(res, 200, { ok: true, result: message });
        return;
      }
      case 'getUpdates': {
        offsetsSeen.push(String(url.searchParams.get('offset') ?? body.offset ?? ''));
        const offset = Number(url.searchParams.get('offset') ?? body.offset ?? 0);
        const timeoutS = Number(url.searchParams.get('timeout') ?? body.timeout ?? 0);
        confirm(offset);
        const ready = pending(offset);
        if (ready.length > 0 || timeoutS <= 0 || !longPollHonoured) {
          reply(res, 200, { ok: true, result: ready });
          return;
        }
        // Park until an update arrives or the long-poll timeout lapses (empty result).
        const poll: ParkedPoll = {
          offset,
          res,
          timer: setTimeout(() => {
            parked.delete(poll);
            reply(res, 200, { ok: true, result: [] });
          }, timeoutS * 1000),
        };
        parked.add(poll);
        // Client aborted (plugin disconnect): unpark quietly. Listen on the RESPONSE, not the
        // request — the request stream is fully consumed by the time a poll parks, so `req` has
        // already emitted 'close' and a listener added here would never fire.
        res.on('close', () => {
          clearTimeout(poll.timer);
          parked.delete(poll);
        });
        return;
      }
      default: {
        reply(res, 404, { ok: false, error_code: 404, description: `Unknown method ${method}` });
        return;
      }
    }
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      reply(res, 500, { ok: false, error_code: 500, description: 'fake internal error' });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('fake telegram failed to bind');

  let userSeq = 1;
  const human = (from: string): TgMessage['from'] => ({
    id: userSeq++,
    is_bot: false,
    username: from,
    first_name: from,
  });

  return {
    url: `http://127.0.0.1:${addr.port}`,
    token: TOKEN,
    sent,

    injectRaw(chatId: string, payload: Record<string, unknown>, as = 'message'): number {
      const message = enqueue(chatId, payload);
      const update: TgUpdate = { update_id: updateSeq++ };
      if (as === 'channel_post') update.channel_post = message;
      else update.message = message;
      updates.push(update);
      wakeParked();
      return message.message_id;
    },

    injectRawUpdate(payload: Record<string, unknown>): number {
      const update = { ...payload, update_id: updateSeq++ } as TgUpdate;
      updates.push(update);
      wakeParked();
      return update.update_id;
    },

    injectMalformedUpdate(payload: Record<string, unknown>): void {
      updates.push(payload as unknown as TgUpdate);
      wakeParked();
    },

    injectUserMessage(chatId: string, from: string, text: string): number {
      return this.injectRaw(chatId, { from: human(from), text });
    },

    injectUserMessageDeferred(
      chatId: string,
      from: string,
      text: string,
    ): { messageId: number; release(): void } {
      const message = enqueue(chatId, { from: human(from), text });
      let released = false;
      return {
        messageId: message.message_id,
        release(): void {
          if (released) return;
          released = true;
          updates.push({ update_id: updateSeq++, message });
          wakeParked();
        },
      };
    },

    failMethod(method: string, failure: Failure | undefined): void {
      if (failure === undefined) failures.delete(method);
      else failures.set(method, failure);
    },

    holdMethod(method: string): { release(): void } {
      let release = (): void => undefined;
      const promise = new Promise<void>((resolve) => {
        release = () => {
          holds.delete(method);
          resolve();
        };
      });
      holds.set(method, { promise, release });
      return { release: () => release() };
    },

    stallMethod(method: string, mode: StallMode | undefined): void {
      if (mode === undefined) stalls.delete(method);
      else stalls.set(method, mode);
    },

    ignoreLongPoll(on: boolean): void {
      longPollHonoured = !on;
      if (on) for (const poll of [...parked]) answerPoll(poll);
    },

    ignoreOffset(on: boolean): void {
      offsetHonoured = !on;
      if (on) for (const poll of [...parked]) answerPoll(poll);
    },

    malformMethod(method: string, body: string | undefined): void {
      if (body === undefined) malformed.delete(method);
      else malformed.set(method, body);
    },

    spellChatId(spell: ((id: number) => number | string) | undefined): void {
      spellChatId = spell;
    },

    callCount(method: string): number {
      return calls.get(method) ?? 0;
    },

    callTimes(method: string): number[] {
      return [...(times.get(method) ?? [])];
    },

    pollOffsets(): string[] {
      return [...offsetsSeen];
    },

    parkedPolls(): number {
      return parked.size;
    },

    retainedUpdates(): number {
      return updates.length;
    },

    async close(): Promise<void> {
      for (const hold of [...holds.values()]) hold.release();
      for (const poll of [...parked]) answerPoll(poll);
      for (const res of stalled.values()) res.socket?.destroy();
      stalled.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined || err === null ? resolve() : reject(err)));
      });
    },
  };
}

/** Collect and JSON-parse a request body (empty object for GETs / empty bodies). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
