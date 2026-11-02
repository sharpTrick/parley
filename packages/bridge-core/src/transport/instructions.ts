import { withInboundTrustBoundary } from '../inbound-trust.js';
import type { WhoAmI } from './tool-deps.js';

/**
 * How participants talk on Parley, in the words every server ships to its model. Kept short: it is
 * in the system prompt of every session on every bridge.
 */
export const CONVERSATION_CONVENTIONS = [
  'Say whether you need an answer: end a message with "Reply needed: <what>" or "No reply needed";',
  'with neither, none is expected. Answer only a message that asks for one — not an FYI, an',
  'acknowledgement, thanks, or your own words coming back, and never acknowledge an acknowledgement.',
  'Address someone with @<handle>. Keep a conversation in the topic it started in, threading with',
  'in_reply_to. Make each message stand on its own: cite message ids, paths and PRs. Never post',
  'secrets.',
];

/** A server's instructions: what its transport does, who this instance is, and the conventions. */
export function serverInstructions(body: readonly string[], who: WhoAmI): string {
  return withInboundTrustBoundary([
    ...body,
    `You are ${who.handle}; parley_whoami says what this bridge can do.`,
    ...(who.directory !== undefined ? [`Reaching others: ${who.directory}`] : []),
    ...CONVERSATION_CONVENTIONS,
  ]);
}
