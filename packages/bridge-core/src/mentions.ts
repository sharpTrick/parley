import { asHandle, type Handle } from './message.js';

// An alnum-led, alnum-ended token; interior `-`, `_`, `.` are allowed (e.g. @ctx-payments) but a
// trailing one is not, so sentence punctuation ("ping @bob.") isn't absorbed into the handle.
const HANDLE_BODY = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?';

// `@` preceded by start-of-string or a non-handle char — the leading guard stops us matching
// emails like alice@example.com mid-token.
const MENTION_RE = new RegExp(`(?:^|[^A-Za-z0-9_.@-])@(${HANDLE_BODY})`, 'g');

const HANDLE_RE = new RegExp(`^(?:${HANDLE_BODY})$`);

/**
 * True if `handle` is one {@link parseMentions} can produce — i.e. `@<handle>` in message content
 * yields exactly `handle`. The mention-filter compares parsed mentions against a configured handle,
 * so a handle failing this can never match anything.
 */
export function isMentionableHandle(handle: string): boolean {
  return HANDLE_RE.test(handle);
}

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
