import { DEFAULT_PRESENCE_TOPIC, encodePresence, type PresenceKind } from '../engine/presence.js';
import { asHandle, asTopic } from '../message.js';
import type { FakePlugin } from './fake-plugin.js';
import { toolClient, type ToolHarness, type ToolHarnessOptions } from './tool-harness.js';

/**
 * What every tool-facing suite needs on top of {@link toolClient}: the shape a tool result comes
 * back in, and a way to plant a presence beat. Shared rather than restated, so that a suite reading
 * a roster and a suite reading a message page agree on what a tool answer looks like.
 */

export interface ToolText {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** The JSON payload a tool answers with. */
export const parse = (r: unknown): unknown => JSON.parse((r as ToolText).content[0]!.text);

export interface RosterResult {
  users: Array<{
    handle: string;
    online: boolean;
    topics: string[];
    postTopics: string[];
    lastSeenMs: number;
  }>;
  truncated: boolean;
}

export const PRESENCE_TOPIC = asTopic(DEFAULT_PRESENCE_TOPIC);

/**
 * Only the overrides a case actually names reach the shared harness. Keep the undefined-stripping,
 * so that an option a caller leaves unset keeps the harness default instead of opting OUT of the
 * dependency — the harness reads an explicitly-undefined key as "this test wants it absent".
 */
export function harness(opts: ToolHarnessOptions = {}): Promise<ToolHarness> {
  return toolClient(Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)));
}

/** Post a presence beat straight to the shared presence topic (as the emitter would). */
export function postBeat(
  plugin: FakePlugin,
  handle: string,
  topics: string[],
  kind: PresenceKind,
  at: number,
  postTopics: string[] = [],
  instanceId = '',
): Promise<unknown> {
  return plugin.post(
    PRESENCE_TOPIC,
    asHandle(handle),
    encodePresence({ v: 2, kind, at, topics, postTopics, instanceId }),
  );
}
