import { parseMentions } from '@sharptrick/parley-core';
import { expect, it } from 'vitest';
import type { ConformanceContext } from '../factory.js';
import { OTHER, SENDER } from '../handles.js';
import { CONTENT_SHAPES } from './content.js';

/** The write path: what `post` carries through, and who the seam says sent it. */
export function postCases(ctx: ConformanceContext): void {
  // Every other case posts short ASCII ('a', 'same', 'm0'), so nothing else certifies that `post`
  // round-trips content at all: the same `parley_post` could behave four different ways across
  // certified backends. Refusing a payload is a visible, legitimate answer; altering it silently
  // is not. The table is SHARED with the live floor, so a shape added for one path is graded on
  // both — these payloads used to reach `post` and `fetchRecent` only, and never a live handler.
  //
  // Which answer a backend gives is its DECLARATION, not its choice per run: `refusesContentShapes`
  // names the labels it refuses, and both arms are graded against it. While the arm was implicit —
  // "either round-trips or refuses", with the live floor silently retrying a refused shape as a
  // bare token — a backend refusing every one of these and dropping every long, non-ASCII or
  // control-carrying message live was certified 36 of 36.
  it.each(CONTENT_SHAPES.map(([label, body]) => [label, body] as [string, string]))(
    'post either round-trips %s exactly or refuses it — and which, this fixture DECLARES',
    async (label, content) => {
      const declaredRefused = ctx.refusesContentShapes.includes(label);
      const t = ctx.freshTopic();
      const posted: string | Error = await ctx.plugin.post(t, SENDER, content).then(
        (id) => String(id),
        (err: unknown) => err as Error,
      );
      if (declaredRefused) {
        expect(
          posted,
          'the fixture declares this shape refused, so the live floor does not carry it and the ' +
            'round trip below is not graded — but `post` accepted it. A declaration that buys a ' +
            'weaker grade has to be true',
        ).toBeInstanceOf(Error);
        expect((posted as Error).message.length).toBeGreaterThan(0);
        return;
      }
      expect(
        posted,
        '`post` refused a shape this fixture did not declare refused. Refusing is a legitimate ' +
          'arm — declare it in `refusesContentShapes`, which also states that the live floor ' +
          'cannot carry it — but it may not be taken silently',
      ).not.toBeInstanceOf(Error);
      const { messages } = await ctx.plugin.fetchRecent({ topic: t });
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe(content);
      expect(messages[0]!.mentions).toEqual(parseMentions(content));
    },
  );

  // `post`'s `opts.inReplyTo` is part of the seam and core's post tool passes it
  // (transport/tools.ts). The seam surfaces no reply field on Message, so the contract is exactly
  // "accepted, and durable in order" — a plugin that 400s on a threaded reply does not conform.
  it('post accepts inReplyTo and the reply is durable, in order', async () => {
    const t = ctx.freshTopic();
    const parent = await ctx.plugin.post(t, SENDER, 'question');
    const reply = await ctx.plugin.post(t, SENDER, 'answer', { inReplyTo: parent });
    expect(reply).not.toBe(parent);

    const { messages } = await ctx.plugin.fetchRecent({ topic: t });
    expect(messages.map((m) => m.content)).toEqual(['question', 'answer']);
    expect(messages.map((m) => m.backendMsgId)).toEqual([parent, reply]);
  });

  it('resolveIdentity answers for the handle it was asked about', async () => {
    const id = await ctx.plugin.resolveIdentity(SENDER);
    expect(id.handle).toBe(SENDER);
    expect(typeof id.backendRef).toBe('string');
    expect(id.backendRef.length).toBeGreaterThan(0);
  });

  it('distinct senders are not collapsed onto one another', async () => {
    const t = ctx.freshTopic();
    await ctx.plugin.post(t, SENDER, 'from-first');
    await ctx.plugin.post(t, OTHER, 'from-second');
    const { messages } = await ctx.plugin.fetchRecent({ topic: t });
    expect(messages.map((m) => m.content)).toEqual(['from-first', 'from-second']);
    if (ctx.carriesSenderIdentity) {
      expect(messages.map((m) => m.senderHandle)).toEqual([SENDER, OTHER]);
    } else {
      // Declaring `identity` not carried buys a WEAKER contract, not none. Without this arm the
      // flag deletes every sender assertion, so a backend that scrambles or blanks `senderHandle`
      // — which core routes and displays — passes by flipping one boolean.
      expect(new Set(messages.map((m) => m.senderHandle)).size).toBe(1);
      expect(messages[0]!.senderHandle.length).toBeGreaterThan(0);
      expect(messages[0]!.backendMsgId).not.toBe(messages[1]!.backendMsgId);
    }
  });
}
