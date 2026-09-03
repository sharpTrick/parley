import type { BackendConfig, MessageHandler, Topic } from '@sharptrick/parley-core';
import {
  assertKnownBackendConfig,
  DEFAULT_ALLOWED_MENTIONS,
  reconnectCapFor,
  requireDistinctChannels,
  requireRoutableChannel,
  type AllowedMentions,
  type DiscordBackendConfig,
} from './config.js';
import { plaintextCredentialRisks } from './creds.js';
import { warn } from './diagnostics.js';
import { DiscordGateway } from './gateway.js';
import { DiscordRest } from './rest.js';
import { wake, type Waiters } from './waiters.js';
import { toMessage, type DiscordMessage } from './wire.js';

/**
 * One connected Discord session: the REST and gateway transports, the config they were opened with,
 * and the topic → channel resolution every seam call goes through.
 */
export abstract class DiscordSession {
  private channelMap = new Map<string, string>();
  /** Reverse of {@link channelMap}: channel id → the ONE topic that owns it. */
  private channelOwner = new Map<string, string>();
  protected allowedMentions: AllowedMentions = DEFAULT_ALLOWED_MENTIONS;
  private connected = false;
  protected stopped = false;
  /**
   * Bumped by every `connect()` and captured by each seam call before its first await. Keep every
   * query a call makes behind that capture, so that one parked across a re-`connect()` cannot
   * resume against the NEW `channel_map` and hand its caller another channel's messages and cursor
   * under the topic it asked about — `stopped` cannot say so, `connect()` sets it back to false.
   */
  protected generation = 0;
  protected readonly rest = new DiscordRest(() => this.stopped);
  protected readonly gateway = new DiscordGateway(this.rest, {
    isStopped: () => this.stopped,
    onMessage: (m) => this.dispatch(m),
    onSocketGone: () => wake(this.waiters),
  });
  /** channel id → subscription; MESSAGE_CREATE dispatch routes through this. */
  protected readonly subs = new Map<string, { topic: Topic; handler: MessageHandler }>();
  protected readonly waiters: Waiters = new Map();
  /** Memoized `GET /users/@me` (the bot's own account), for resolveIdentity. */
  protected me?: Promise<{ id: string; username: string }>;

  async connect(config: BackendConfig): Promise<void> {
    assertKnownBackendConfig(config);
    const cfg = config as DiscordBackendConfig;
    const channelMap = new Map(Object.entries(cfg.channel_map ?? {}));
    const channelOwner = requireDistinctChannels(channelMap);
    const reconnectCapMs = reconnectCapFor(cfg.gateway_dialers);

    // Retire the previous session BEFORE installing the new config, so that a re-entrant connect()
    // cannot leave the old socket dispatching into a plugin whose `live` flag says there is none —
    // which silently degrades every later native long-poll to an immediate return.
    this.stopped = true;
    this.generation++;
    this.gateway.restart(cfg, reconnectCapMs);
    this.forgetTopics();

    this.rest.configure(cfg.api_url, cfg.token);
    this.channelMap = channelMap;
    this.channelOwner = channelOwner;
    this.allowedMentions = cfg.allowed_mentions ?? DEFAULT_ALLOWED_MENTIONS;
    this.stopped = false;
    this.connected = true;

    for (const risk of plaintextCredentialRisks(cfg)) warn(`SECURITY: ${risk}`);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.gateway.stop();
    this.forgetTopics();
  }

  private forgetTopics(): void {
    this.subs.clear();
    wake(this.waiters);
    this.waiters.clear();
    this.me = undefined;
  }

  private dispatch(m: DiscordMessage): void {
    const sub = this.subs.get(m.channel_id);
    if (sub !== undefined) {
      try {
        // Keep the rejection arm UNAWAITED, so that a handler which never settles cannot park
        // every later message behind it — awaiting trades a crash for a silent stall.
        void Promise.resolve(sub.handler(toMessage(sub.topic, m))).catch(() => undefined);
      } catch {
        /* handler is best-effort; never break the loop (DESIGN §6) */
      }
    }
    wake(this.waiters, m.channel_id);
  }

  /**
   * Topic → Discord channel id: `channel_map` entry, else the topic string IS the channel id. Keep
   * the collision refused HERE rather than at one entry point, so that the same Discord message can
   * never cross the seam under two topic labels and interleave the two topics' cursors.
   */
  protected channelId(topic: Topic): string {
    const mapped = this.channelMap.get(topic as string);
    const owner = mapped === undefined ? this.channelOwner.get(topic as string) : undefined;
    if (owner !== undefined) {
      throw new Error(
        `Discord topics ${JSON.stringify(owner)} and ${JSON.stringify(topic)} both ` +
          `resolve to channel ${topic as string}; give each topic its own channel_map target`,
      );
    }
    return requireRoutableChannel(topic, mapped ?? (topic as string));
  }

  protected require(): void {
    if (!this.connected) throw new Error('DiscordPlugin not connected — call connect() first');
  }

  /**
   * The ladder state, forwarded under the names the gateway suites read off the PLUGIN. Keep these
   * `protected` rather than `private`, so that noUnusedLocals does not read them as dead: the only
   * callers reach them at runtime through an `as unknown as` cast, which the compiler cannot see.
   */
  protected get reconnectAttempts(): number {
    return this.gateway.reconnectAttempts;
  }
  protected get heartbeats(): ReadonlySet<NodeJS.Timeout> {
    return this.gateway.heartbeats;
  }
}
