import {
  asBackendMsgId,
  asCursor,
  asHandle,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type Message,
  type MessageHandler,
  parseMentions,
  type Topic,
} from '@parley/core';
import { createClient } from 'redis';

type RedisClient = ReturnType<typeof createClient>;

/** Plugin-specific backend_config. */
export interface RedisBackendConfig {
  /** Connection URL. Default `redis://127.0.0.1:6379`. */
  url?: string;
  /** Stream key prefix. Default `parley:`. One Redis Stream per topic: `<prefix><topic>`. */
  key_prefix?: string;
  /** XREAD BLOCK timeout (ms) — the loop re-checks for shutdown each interval. Default 2000. */
  block_ms?: number;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Redis Streams backend (DESIGN §6/§9) — the FIRST event-driven push backend. A Stream entry id
 * (`XADD *`, e.g. `1700-0`) is monotonic per stream and serves as BOTH `backendMsgId` (dedup key)
 * and `cursor` (order key). `fetchRecent` = `XRANGE` (exclusive `(since`); `subscribe` = an
 * `XREAD BLOCK` loop on a dedicated connection driven by REAL events, not a poll timer. Stream ids
 * are not lexically comparable, but core never compares cursors — Redis returns entries in order.
 */
export class RedisPlugin implements BackendPlugin {
  private client?: RedisClient;
  private prefix = 'parley:';
  private blockMs = 2000;
  private stopped = false;
  private readonly readers: RedisClient[] = [];

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as RedisBackendConfig;
    this.prefix = cfg.key_prefix ?? 'parley:';
    this.blockMs = cfg.block_ms ?? 2000;
    this.stopped = false;
    const client = createClient({ url: cfg.url ?? 'redis://127.0.0.1:6379' });
    client.on('error', () => {
      /* transient connection errors surface via command rejections; don't crash the process */
    });
    await client.connect();
    this.client = client;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    for (const reader of this.readers.splice(0)) {
      await reader.disconnect().catch(() => undefined);
    }
    if (this.client !== undefined) {
      await this.client.disconnect().catch(() => undefined);
      this.client = undefined;
    }
  }

  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    const id = await this.require().xAdd(this.key(topic), '*', {
      sender: identity,
      content,
      ts: new Date().toISOString(),
      in_reply_to: opts?.inReplyTo ?? '',
    });
    return asBackendMsgId(id);
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const key = this.key(args.topic);
    const limit = args.limit ?? 100;
    let entries: Array<{ id: string; message: Record<string, string> }>;
    if (args.since === undefined) {
      // Default window: the most recent `limit` entries, returned ascending by cursor.
      entries = (await this.require().xRevRange(key, '+', '-', { COUNT: limit })).reverse();
    } else {
      // Exclusive: strictly after `since`, ascending. `(` makes XRANGE start exclusive.
      entries = await this.require().xRange(key, `(${args.since}`, '+', { COUNT: limit });
    }
    const messages = entries.map((e) => rowToMessage(args.topic, e.id, e.message));
    const last = messages.at(-1);
    const nextCursor = last !== undefined ? last.cursor : (args.since ?? asCursor('0-0'));
    return { messages, nextCursor };
  }

  /**
   * Live path = an `XREAD BLOCK` loop on a dedicated connection (DESIGN §9 — genuine events, not a
   * poll timer). Starts at `$` (new entries only; history is owned by catch-up). `disconnect()`
   * tears the reader down, which breaks the blocking read.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const reader = this.require().duplicate();
    reader.on('error', () => undefined);
    await reader.connect();
    this.readers.push(reader);
    const key = this.key(topic);

    const loop = async (): Promise<void> => {
      let lastId = '$';
      while (!this.stopped) {
        let res:
          | Array<{ name: string; messages: Array<{ id: string; message: Record<string, string> }> }>
          | null;
        try {
          res = await reader.xRead({ key, id: lastId }, { BLOCK: this.blockMs, COUNT: 256 });
        } catch {
          if (this.stopped) break;
          await delay(100);
          continue;
        }
        if (this.stopped) break;
        if (res === null) continue; // BLOCK timed out with no new entries
        for (const stream of res) {
          for (const entry of stream.messages) {
            lastId = entry.id;
            try {
              handler(rowToMessage(topic, entry.id, entry.message));
            } catch {
              /* handler is best-effort; never break the loop (DESIGN §6) */
            }
          }
        }
      }
    };
    void loop();
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }

  private key(topic: Topic): string {
    return `${this.prefix}${topic}`;
  }

  private require(): RedisClient {
    if (this.client === undefined) {
      throw new Error('RedisPlugin not connected — call connect() first');
    }
    return this.client;
  }
}

function rowToMessage(topic: Topic, id: string, fields: Record<string, string>): Message {
  const content = fields.content ?? '';
  return {
    topic,
    senderHandle: asHandle(fields.sender ?? ''),
    content,
    timestamp: fields.ts ?? '',
    backendMsgId: asBackendMsgId(id),
    cursor: asCursor(id),
    mentions: parseMentions(content),
  };
}
