import { asHandle, type Handle } from './message.js';

// `@` preceded by start-of-string or a non-handle char, then an alnum-led, alnum-ended token.
// Handles may contain interior `-`, `_`, `.` (e.g. @ctx-payments) but not a trailing one, so
// sentence punctuation ("ping @bob.") isn't absorbed into the handle. The leading guard stops
// us matching emails like alice@example.com mid-token.
const MENTION_RE = /(?:^|[^A-Za-z0-9_.@-])@([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/g;

/**
 * Parse @mentions from message content. SHARED by every backend so mention semantics
 * are uniform across transports (a plugin populates `Message.mentions` with this; core's
 * mention-filter reads `Message.mentions`). Returns unique handles in first-seen order.
 */
export function parseMentions(content: string): Handle[] {
  const out: Handle[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(MENTION_RE)) {
    const handle = match[1];
    if (handle !== undefined && !seen.has(handle)) {
      seen.add(handle);
      out.push(asHandle(handle));
    }
  }
  return out;
}
