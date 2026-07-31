import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TelegramBackendConfig } from './index.js';

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
