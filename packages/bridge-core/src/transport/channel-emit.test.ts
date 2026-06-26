import { describe, expect, it } from 'vitest';
import { asBackendMsgId, asCursor, asHandle, asTopic, type Message } from '../message.js';
import { channelMeta } from './channel-emit.js';

const msg = (over: Partial<Message> = {}): Message => ({
  topic: asTopic('ctx-payments'),
  senderHandle: asHandle('ctx-payments'),
  content: 'hi @bob',
  timestamp: '1970-01-01T00:00:00.000Z',
  backendMsgId: asBackendMsgId('7'),
  cursor: asCursor('7'),
  mentions: [asHandle('bob')],
  ...over,
});

describe('channelMeta', () => {
  it('uses identifier keys only — no hyphens (which Claude Code silently drops)', () => {
    const meta = channelMeta(msg());
    for (const key of Object.keys(meta)) expect(key).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(Object.keys(meta).sort()).toEqual(['cursor', 'mentions', 'msg_id', 'sender', 'topic']);
  });

  it('keeps hyphenated VALUES (topic/sender) intact', () => {
    const meta = channelMeta(msg());
    expect(meta.topic).toBe('ctx-payments');
    expect(meta.sender).toBe('ctx-payments');
    expect(meta.msg_id).toBe('7');
    expect(meta.cursor).toBe('7');
    expect(meta.mentions).toBe('bob');
  });

  it('omits mentions when there are none', () => {
    const meta = channelMeta(msg({ mentions: [], content: 'no mentions' }));
    expect(meta).not.toHaveProperty('mentions');
  });
});
