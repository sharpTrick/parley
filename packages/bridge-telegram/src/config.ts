import { homedir } from 'node:os';
import { join } from 'node:path';

/** Bot API base URL when `backend_config.api_url` is unset. Keep it https — see `plaintextWarning`. */
export const DEFAULT_API_URL = 'https://api.telegram.org';

/** Plugin-specific backend_config (DESIGN §11). */
export interface TelegramBackendConfig {
  /** Bot token from @BotFather. A secret — lives in `backend_config`/`.env`, never in code. */
  token?: string;
  /** Bot API base URL, default {@link DEFAULT_API_URL}; a plaintext one is warned about on connect. */
  api_url?: string;
  /**
   * Path of the observed-message JSONL store, default {@link defaultStorePath}. A store file that
   * goes missing while a saved cursor survives invalidates that cursor: sequences restart at 1 and
   * `fetchRecent` reports the loss rather than serving a short page (see `ObservedStore.epoch`).
   */
  store_path?: string;
  /** `getUpdates` long-poll timeout (SECONDS — Telegram's unit), default 25. */
  poll_timeout_s?: number;
  /**
   * Parley topic → Telegram chat id. A topic missing from the map is used as the chat id
   * literal (numeric id string or `@channelusername`).
   */
  chat_map?: Record<string, string>;
  /**
   * Max observed records retained PER CHAT — per chat, not per topic: `chat_map` can give one chat
   * two topic names. Default 10000.
   */
  observed_retention_per_chat?: number;
  /** Deprecated spelling of {@link observed_retention_per_chat}, which wins when both are set. */
  observed_retention_per_topic?: number;
  /**
   * Max UNSERVED chats retained. Anyone who can add the bot to a group can drive writes into
   * `store_path`, so that traffic is bounded; a chat a configured topic or a seam call resolves to
   * is retained on top of this cap. Default 1000.
   */
  observed_max_chats?: number;
}

/**
 * Accepted range of every numeric knob. Telegram accepts a `getUpdates` timeout up to 50s, and
 * both retention bounds size in-memory state, so each has a ceiling as well as a floor.
 */
const NUMERIC_KNOBS: Record<NumericKnob, readonly [number, number]> = {
  poll_timeout_s: [1, 50],
  observed_retention_per_chat: [1, 10_000_000],
  observed_retention_per_topic: [1, 10_000_000],
  observed_max_chats: [1, 1_000_000],
};

/** The `backend_config` keys {@link NUMERIC_KNOBS} bounds — renaming one has to break the build. */
type NumericKnob = keyof Pick<
  TelegramBackendConfig,
  'poll_timeout_s' | 'observed_retention_per_chat' | 'observed_retention_per_topic' | 'observed_max_chats'
>;

/**
 * Fail `connect` on an out-of-domain knob, naming the key. Keep this ahead of every other effect,
 * so that a value which would flood the vendor (`poll_timeout_s: 0`), kill the only ingestion path
 * (a negative one) or silently widen a retention bound the operator narrowed is a load error
 * rather than a running bridge doing the opposite of what the config asked.
 */
export function requireNumericKnobs(cfg: TelegramBackendConfig): void {
  for (const key of Object.keys(NUMERIC_KNOBS) as NumericKnob[]) {
    const value = cfg[key];
    if (value === undefined) continue;
    const [min, max] = NUMERIC_KNOBS[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(
        `TelegramPlugin: backend_config.${key} must be an integer in [${min}, ${max}] — ` +
          `got ${String(value)}`,
      );
    }
  }
}

/**
 * Default observed-message store: `${XDG_STATE_HOME:-~/.local/state}/parley/telegram/observed.jsonl`
 * — the directory core keeps its read-state (the saved cursors) in. Keep it ABSOLUTE, so that
 * relaunching the bridge from another working directory cannot silently start a fresh sequence
 * space underneath cursors an agent is still holding. One bridge per bot token (README), so one
 * default file; give a second deployment its own `store_path`.
 */
export function defaultStorePath(): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(base, 'parley', 'telegram', 'observed.jsonl');
}
