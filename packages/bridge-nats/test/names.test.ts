import { asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { legalStreamName, legalSubject, SUBJECT_ILLEGAL, STREAM_ILLEGAL } from './helpers.js';

// Class: a character the fold leaves in place composes a name NATS cannot carry. A topic is named
// by a CALLER — `post_topics` is a regex over names an untrusted inbound message can choose — so the
// fold, not the operator, is the only thing between that name and a JetStream API request the server
// answers with an opaque frame naming neither the topic nor the field. Every illegal character is
// crossed with every position it can occupy, because a fold anchored at one end passes the others.
// config.test.ts's `topicLengths` rows are the neighbouring test that cannot reach this: they vary a
// topic's LENGTH only, never its charset.

const names = (topic: Topic): { subject: string; stream: string } => {
  const plugin = new NatsPlugin() as unknown as {
    subject: (t: Topic) => string;
    streamName: (t: Topic) => string;
  };
  return { subject: plugin.subject(topic), stream: plugin.streamName(topic) };
};

const positions: { name: string; place: (ch: string) => string }[] = [
  { name: 'start', place: (ch) => `${ch}chat` },
  { name: 'middle', place: (ch) => `chat${ch}room` },
  { name: 'end', place: (ch) => `chat${ch}` },
  { name: 'alone', place: (ch) => ch },
  { name: 'doubled', place: (ch) => `chat${ch}${ch}room` },
];

const hex = (ch: string): string => `U+${ch.codePointAt(0)!.toString(16).padStart(4, '0').toUpperCase()}`;

const illegal = [...new Set([...SUBJECT_ILLEGAL, ...STREAM_ILLEGAL])];

describe('nats topic fold — every illegal character composes a legal name', () => {
  it('grades the whole illegal set, not a hand-picked corner of it', () => {
    expect(illegal).toContain('.');
    expect(illegal).toContain('*');
    expect(illegal).toContain('>');
    expect(illegal).toContain('/');
    expect(illegal).toContain('\\');
    expect(illegal).toContain(' ');
    expect(illegal.filter((c) => c.codePointAt(0)! < 0x20)).toHaveLength(0x20);
    expect(illegal).toContain(String.fromCharCode(0x7f));
  });

  for (const position of positions) {
    for (const ch of illegal) {
      it(`${hex(ch)} at the ${position.name} of a topic folds to a legal subject and stream name`, () => {
        const raw = position.place(ch);
        const { subject, stream } = names(asTopic(raw));

        expect({ char: hex(ch), subject, legal: legalSubject(subject) }).toEqual({
          char: hex(ch),
          subject,
          legal: true,
        });
        expect({ char: hex(ch), stream, legal: legalStreamName(stream) }).toEqual({
          char: hex(ch),
          stream,
          legal: true,
        });
      });
    }
  }

  // The fold is many-to-one, so legality alone would be satisfied by mapping every topic onto one
  // name — which cross-delivers two conversations. The disambiguating suffix is what stops that, and
  // an illegal character is exactly the input that forces it to run.
  it('never collides two topics that differ only in an illegal character', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const position of positions) {
      for (const ch of illegal) {
        const raw = position.place(ch);
        const { subject, stream } = names(asTopic(raw));
        for (const name of [`subject:${subject}`, `stream:${stream}`]) {
          const owner = seen.get(name);
          if (owner !== undefined && owner !== raw) collisions.push(`${name} ← ${owner} and ${raw}`);
          seen.set(name, raw);
        }
      }
    }
    expect(collisions).toEqual([]);
  });
});
