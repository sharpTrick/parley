import { describe, expect, it } from 'vitest';
import {
  asBackendMsgId,
  asCursor,
  asHandle,
  asTopic,
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
