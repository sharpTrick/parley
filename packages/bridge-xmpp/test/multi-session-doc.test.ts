import { asHandle } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { XmppPlugin, type XmppBackendConfig } from '../src/index.js';
import { BASE, canAuth, freshTopic, SECOND_ACCOUNT } from './live-xmpp.js';

// Class: a README safety claim of the form "this misconfiguration fails loudly" that no test
// exercises. The multi-session page tells operators which fields may be shared across concurrent
// sessions and what happens when one is not; "the second session's join fails outright — a loud
// error, not a silent split" was simply false for a shared account (XEP-0045 scopes the unique-nick
// rule to the BARE JID, so two resources of one account occupy a room under one nick and every
// message from both is attributed to it). Each row below is one documented config divergence,
// pinned to the outcome the README now promises.

type Outcome = 'merged-senders' | 'distinct-senders' | 'loud-conflict';

interface Row {
  name: string;
  a: Partial<XmppBackendConfig>;
  b: Partial<XmppBackendConfig>;
  /** The `identity.handle` each session posts under; unset nicks are taken from it. */
  handles?: [string, string];
  expected: Outcome;
}

const rows: Row[] = [
  {
    name: 'shared account + the SAME pinned nick: silently merged, no error anywhere',
    a: { nick: 'pinned-same' },
    b: { nick: 'pinned-same' },
    expected: 'merged-senders',
  },
  {
    name: 'shared account + nick unset, distinct identity.handle: distinct senders',
    a: {},
    b: {},
    expected: 'distinct-senders',
  },
  {
    name: 'shared account + nick unset, the SAME identity.handle: silently merged',
    a: {},
    b: {},
    handles: ['same-handle', 'same-handle'],
    expected: 'merged-senders',
  },
  {
    name: 'shared account + a distinct pinned nick each: distinct senders',
    a: { nick: 'pinned-a' },
    b: { nick: 'pinned-b' },
    expected: 'distinct-senders',
  },
];

const conflictRow: Row = {
  name: 'DIFFERENT accounts + the same pinned nick: a loud conflict error',
  a: { nick: 'pinned-clash' },
  b: { ...SECOND_ACCOUNT, nick: 'pinned-clash' },
  expected: 'loud-conflict',
};

const serverUp = await canAuth(BASE);
const secondAccount = serverUp && (await canAuth(SECOND_ACCOUNT));

describe.skipIf(!serverUp)('XMPP multi-session config claims (README)', () => {
  const run = async (row: Row): Promise<void> => {
    const a = new XmppPlugin();
    const b = new XmppPlugin();
    const topic = freshTopic('ms');
    const [handleA, handleB] = row.handles ?? ['a', 'b'];
    try {
      await a.connect({ ...BASE, ...row.a });
      await b.connect({ ...BASE, ...row.b });
      await a.post(topic, asHandle(handleA), 'from-a');

      if (row.expected === 'loud-conflict') {
        await expect(b.post(topic, asHandle(handleB), 'from-b')).rejects.toThrow(/conflict/);
        return;
      }

      await b.post(topic, asHandle(handleB), 'from-b');
      const read = await a.fetchRecent({ topic, limit: 10 });
      const senders = new Map(read.messages.map((m) => [m.content, String(m.senderHandle)]));
      expect([...senders.keys()].sort()).toEqual(['from-a', 'from-b']);
      const [senderA, senderB] = [senders.get('from-a'), senders.get('from-b')];
      if (row.expected === 'merged-senders') {
        expect(senderA).toBe(senderB); // the documented silent split
      } else {
        expect(senderA).not.toBe(senderB);
      }
    } finally {
      await a.disconnect();
      await b.disconnect();
    }
  };

  it.each(rows)('$name', async (row) => {
    await run(row);
  });

  it.skipIf(!secondAccount)(conflictRow.name, async () => {
    await run(conflictRow);
  });
});
