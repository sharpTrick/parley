import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * In-process fake Telegram Bot API (node:http, port 0) — just enough surface for the plugin:
 * `sendMessage`, `getUpdates` (with real long-poll parking + `offset` acknowledgement
 * semantics), and `getMe`.
 *
 * Faithful in the two ways that matter to the seam:
 *  - `message_id` is a PER-CHAT counter (so the composite `<chat>:<mid>` dedup key and the
 *    per-topic numeric cursor are exercised for real), `update_id` a global one.
 *  - `sendMessage` does NOT enqueue the bot's own message as an update — mirrors real
 *    Telegram (a bot never sees its own sends via getUpdates), which forces the plugin's
 *    record-own-post-from-the-response path.
 */
export interface FakeTelegram {
  /** Base URL to hand the plugin as `api_url`. */
  url: string;
  /** Shut down: answer parked polls, drop connections, close the listener. */
  close(): Promise<void>;
  /**
   * Simulate a HUMAN (non-bot) message arriving in `chatId`: allocates the next message_id
   * in the same per-chat sequence sendMessage uses, enqueues an update, and wakes parked
   * long-polls. Returns the minted message_id so tests can assert composite ids.
   */
  injectUserMessage(chatId: string, from: string, text: string): number;
}

interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: string; type: string };
  from: { id: number; is_bot: boolean; username?: string; first_name: string };
  text: string;
  reply_to_message?: { message_id: number };
}

interface TgUpdate {
  update_id: number;
  message: TgMessage;
}

interface ParkedPoll {
  offset: number;
  res: ServerResponse;
  timer: NodeJS.Timeout;
}

const BOT = { id: 999_000_001, is_bot: true, username: 'parley_test_bot', first_name: 'Parley' };

export async function startFakeTelegram(): Promise<FakeTelegram> {
  /** Next message_id PER CHAT — Telegram's message_id is only unique within a chat. */
  const nextMid = new Map<string, number>();
  /** Global update_id counter. */
  let updateSeq = 1;
  /** Every update ever produced; `offset` filtering serves the acknowledged tail. */
  const updates: TgUpdate[] = [];
  /** Long-polls parked until an update they can see arrives (or their timeout lapses). */
  const parked = new Set<ParkedPoll>();

  const mintMid = (chatId: string): number => {
    const mid = nextMid.get(chatId) ?? 1;
    nextMid.set(chatId, mid + 1);
    return mid;
  };

  const pending = (offset: number): TgUpdate[] => updates.filter((u) => u.update_id >= offset);

  const reply = (res: ServerResponse, status: number, payload: unknown): void => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
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

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const match = /^\/bot[^/]+\/(\w+)$/.exec(url.pathname);
    if (match === null) {
      reply(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
      return;
    }
    const method = match[1];
    const body = await readJsonBody(req);

    switch (method) {
      case 'getMe': {
        reply(res, 200, { ok: true, result: BOT });
        return;
      }
      case 'sendMessage': {
        const chatId = String(body.chat_id ?? '');
        const message: TgMessage = {
          message_id: mintMid(chatId),
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'group' },
          from: BOT,
          text: String(body.text ?? ''),
        };
        if (typeof body.reply_to_message_id === 'number') {
          message.reply_to_message = { message_id: body.reply_to_message_id };
        }
        // Faithfully do NOT enqueue own-bot messages as updates (see module doc).
        reply(res, 200, { ok: true, result: message });
        return;
      }
      case 'getUpdates': {
        const offset = Number(url.searchParams.get('offset') ?? body.offset ?? 0);
        const timeoutS = Number(url.searchParams.get('timeout') ?? body.timeout ?? 0);
        const ready = pending(offset);
        if (ready.length > 0 || timeoutS <= 0) {
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
        // Client aborted (plugin disconnect): unpark quietly.
        req.on('close', () => {
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
  return {
    url: `http://127.0.0.1:${addr.port}`,

    injectUserMessage(chatId: string, from: string, text: string): number {
      const message: TgMessage = {
        message_id: mintMid(chatId),
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'group' },
        from: { id: userSeq++, is_bot: false, username: from, first_name: from },
        text,
      };
      updates.push({ update_id: updateSeq++, message });
      wakeParked();
      return message.message_id;
    },

    async close(): Promise<void> {
      for (const poll of [...parked]) answerPoll(poll);
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
