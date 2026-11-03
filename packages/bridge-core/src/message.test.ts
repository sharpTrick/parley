import { describe, expect, it } from 'vitest';
import {
  asBackendMsgId,
  asCursor,
  asHandle,
  asTopic,
  buildMessage,
  type Message,
} from './message.js';

describe('branded identifier types', () => {
  it('constructors round-trip the underlying string', () => {
    expect(asTopic('ctx-payments')).toBe('ctx-payments');
    expect(asHandle('ctx-payments')).toBe('ctx-payments');
    expect(asBackendMsgId('42')).toBe('42');
    expect(asCursor('42')).toBe('42');
  });

  it('assembles a normalized Message', () => {
    const m: Message = {
      topic: asTopic('ctx-payments'),
      senderHandle: asHandle('alice'),
      content: 'hello @bob',
      timestamp: '2026-06-25T22:00:00.000Z',
      backendMsgId: asBackendMsgId('7'),
      cursor: asCursor('7'),
      mentions: [asHandle('bob')],
    };
    expect(m.content).toContain('@bob');
    expect(m.mentions).toEqual(['bob']);
    // timestamp is informational only — never used for ordering/dedup.
    expect(typeof m.cursor).toBe('string');
  });
});

describe('buildMessage', () => {
  it('brands all seven fields and defaults cursor to id', () => {
    const m = buildMessage({
      topic: asTopic('t'),
      sender: 'alice',
      content: 'hi @bob',
      timestamp: '2026-06-25T22:00:00.000Z',
      id: '7',
    });
    expect(m).toEqual({
      topic: 't',
      senderHandle: 'alice',
      content: 'hi @bob',
      timestamp: '2026-06-25T22:00:00.000Z',
      backendMsgId: '7',
      cursor: '7',
      mentions: ['bob'],
    });
    // Default path: backendMsgId and cursor are the same value.
    expect(m.backendMsgId).toBe(m.cursor);
    expect(m.backendMsgId).toBe('7');
  });

  it('keeps backendMsgId and cursor distinct when cursor is passed (Telegram shape)', () => {
    const m = buildMessage({
      topic: asTopic('t'),
      sender: 'alice',
      content: 'hi',
      timestamp: '2026-06-25T22:00:00.000Z',
      id: '42:7',
      cursor: '7',
    });
    expect(m.backendMsgId).toBe('42:7');
    expect(m.cursor).toBe('7');
  });

  it('derives mentions via parseMentions (unique, first-seen order)', () => {
    const m = buildMessage({
      topic: asTopic('t'),
      sender: 'alice',
      content: 'ping @bob and @carol and @bob again',
      timestamp: '2026-06-25T22:00:00.000Z',
      id: '1',
    });
    expect(m.mentions).toEqual([asHandle('bob'), asHandle('carol')]);
  });

  it.each([
    ['an address the content also mentions', 'ping @bob', ['bob'], ['bob'], ['bob']],
    ['an address the plain parse cannot see', 'ping @**bob**', ['bob'], ['bob'], ['bob']],
    ['an address beside a plain mention', 'ping @carol', ['bob'], ['carol', 'bob'], ['bob']],
    ['no addresses', 'ping @carol', [], ['carol'], []],
  ])('keeps every address among the mentions: %s', (_label, content, addressed, mentions, kept) => {
    const m = buildMessage({ topic: asTopic('t'), sender: 'alice', content, timestamp: 'ts', id: '1', addressed });
    expect([m.mentions, m.addressed]).toEqual([mentions.map(asHandle), kept.map(asHandle)]);
  });

  it('leaves `addressed` off a message whose backend cannot tell an address', () => {
    const m = buildMessage({ topic: asTopic('t'), sender: 'alice', content: 'ping @bob', timestamp: 'ts', id: '1' });
    expect('addressed' in m).toBe(false);
  });
});
