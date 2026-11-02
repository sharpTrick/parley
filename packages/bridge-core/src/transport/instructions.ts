import { INBOUND_TRUST_BOUNDARY, inboundTrustBreach, withInboundTrustBoundary } from '../inbound-trust.js';

/** Who an instance is, as far as the instructions it ships say. */
export interface InstructionsSubject {
  handle: string;
  directory?: string;
  mention_filter: boolean;
}

/** The two servers core builds: the stdio channel, and the reactive remote HTTP root. */
export type ServerKind = 'channel' | 'reactive';

/**
 * How participants talk on Parley, in the words every server ships to its model. Kept short: it is
 * in the system prompt of every session on every bridge.
 */
export const CONVERSATION_CONVENTIONS = [
  'Say whether you need an answer: end a message with "Reply needed: <what>" or "No reply needed";',
  'with neither, none is expected. Answer only a message that asks for one — not an FYI, an',
  'acknowledgement, thanks, or your own words coming back, and never acknowledge an acknowledgement.',
  'Name someone with @<handle> so the message reaches them. Keep a conversation in the topic it',
  'started in, threading with in_reply_to. Make each message stand on its own: cite message ids,',
  'paths and PRs. Never post secrets.',
];

const BODY: Record<ServerKind, (who: InstructionsSubject) => string[]> = {
  channel: (who) => [
    'Parley channel: messages from a shared, topic-organized backend arrive as <channel> events',
    'with attributes topic, sender, cursor, msg_id (and mentions).',
    who.mention_filter
      ? 'Only messages that name you are pushed here.'
      : 'Messages on your topics are pushed to you, except one the backend marks as addressed only ' +
        'to others; one that names you reaches you on any topic the backend can carry it from.',
    'Your own messages are never pushed back to you. To respond, call parley_reply with the same',
    '`topic`. To pull missed history for a topic, call parley_fetch_recent (on session start for',
    'each configured topic, then on demand). To publish or hand off, call parley_post. To check',
    'whether the live path is actually delivering — rather than assuming a quiet topic — call',
    'parley_live_status.',
  ],
  reactive: () => [
    'Parley: a shared, topic-organized message backend. To catch up on a topic, call',
    'parley_fetch_recent (on session start for each topic you work in, then on demand). To answer a',
    'message, call parley_reply with the same `topic`. To publish or hand off, call parley_post.',
    'This root receives no live push at all; parley_live_status says so rather than reporting a',
    'health it cannot observe.',
  ],
};

function lines(kind: ServerKind, who: InstructionsSubject): string[] {
  return [
    ...BODY[kind](who),
    `You are ${who.handle}; parley_whoami says what this bridge can do.`,
    ...(who.directory !== undefined ? [`Reaching others: ${who.directory}`] : []),
    ...CONVERSATION_CONVENTIONS,
  ];
}

/** A server's instructions. Throws if they would not uphold the untrusted-inbound boundary. */
export function serverInstructions(kind: ServerKind, who: InstructionsSubject): string {
  return withInboundTrustBoundary(lines(kind, who));
}

/**
 * Why the instructions either server would ship for `who` break the untrusted-inbound boundary, or
 * `undefined`. Run at config load, so that operator text — the handle and the directory — that
 * would break it is refused there rather than failing every server built from it.
 */
export function instructionsBreach(who: InstructionsSubject): string | undefined {
  for (const kind of Object.keys(BODY) as ServerKind[]) {
    const breach = inboundTrustBreach([...lines(kind, who), INBOUND_TRUST_BOUNDARY].join(' '));
    if (breach !== undefined) return breach;
  }
  return undefined;
}
