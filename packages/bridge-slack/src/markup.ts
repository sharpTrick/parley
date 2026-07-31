import { buildMessage, type Message, type Topic } from '@sharptrick/parley-core';
import type { SlackMessage } from './messages.js';

/**
 * Slack's `text` field is its own markup language, and the sender owns the escaping of the three
 * characters that drive it. Escape them on the way OUT, so that relayed content — an inbound Matrix
 * message, a prompt-injected agent turn — carrying `<!channel>`, `<!here>` or `<@U…>` is delivered
 * as literal text instead of becoming a real workspace broadcast or mention. `&` goes first, so that
 * an already-escaped-looking payload is not silently unescaped by the later replacements.
 */
export const escapeSlackText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The inverse, applied on the way IN so one round trip is the identity and a re-post cannot compound
 * the escaping. `&amp;` goes LAST, so that `&amp;lt;` decodes to the literal `&lt;` a user typed
 * rather than all the way to `<`. Keep this AFTER {@link renderMentions}, so that markup a human
 * typed as literal text (`&lt;!channel&gt;`) can never be decoded into markup and then rewritten as
 * a mention.
 */
export const unescapeSlackText = (text: string): string =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Slack's mention markup — `<@U…>`, `<@U…|label>`, `<!subteam^S…|@group>`, `<!here>` — is NOT the
 * `@handle` text core's `parseMentions` reads, so without this rewrite `Message.mentions` holds raw
 * Slack ids and a bridge running with `mention_filter` on delivers nothing.
 *
 * Keep `<` excluded from both bodies, so that the scan starting at one `<` cannot run past the next
 * one: `text` is attacker-controlled up to Slack's own 40 000-character limit, and a body that
 * swallows further `<` gives every one of them an overlapping start position to backtrack over —
 * seconds of the single-threaded event loop per message, Socket Mode acks included.
 */
const MENTION_RE = /<([@!])([^<>|\s]*)(?:\|([^<>]*))?>/g;

/** The `<!…>` bodies that ARE mentions; every other one (`<!date^…>`, …) is left as Slack wrote it. */
const BROADCASTS = new Set(['here', 'channel', 'everyone']);

/** `mention_map` first, then Slack's own label; an unmapped, unlabelled id stays as the id. */
function renderMentions(text: string, mentionMap: Record<string, string>): string {
  return text.replace(MENTION_RE, (raw, sigil: string, body: string, label?: string) => {
    if (sigil === '!' && !BROADCASTS.has(body) && !body.startsWith('subteam^')) return raw;
    const id = sigil === '!' ? body.replace(/^subteam\^/, '') : body;
    const mapped = mentionMap[id];
    if (mapped !== undefined) return `@${mapped}`;
    if (label !== undefined && label.length > 0) return label.startsWith('@') ? label : `@${label}`;
    return id.length > 0 ? `@${id}` : raw;
  });
}

/**
 * The poster's Slack user/bot id, before `mention_map` resolves it to a Parley handle. A workflow-
 * or app-authored entry can carry neither field, and an EMPTY `senderHandle` breaks the seam's
 * well-formedness rule and lands in core's roster as a blank peer, so fall back to a stable name.
 */
const senderOf = (m: SlackMessage): string => {
  for (const id of [m.user, m.bot_id]) {
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return 'unknown';
};

export function slackToMessage(
  topic: Topic,
  m: SlackMessage,
  mentionMap: Record<string, string>,
): Message {
  const id = senderOf(m);
  return buildMessage({
    topic,
    sender: mentionMap[id] ?? id,
    content: unescapeSlackText(renderMentions(m.text ?? '', mentionMap)),
    // Informational only (DESIGN §5) — derived from the ts seconds, never used for ordering.
    timestamp: new Date(Number(m.ts.split('.')[0]) * 1000).toISOString(),
    id: m.ts,
  });
}
