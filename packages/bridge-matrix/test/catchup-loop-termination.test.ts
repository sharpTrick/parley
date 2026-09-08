import {
  Allowlist,
  asHandle,
  asTopic,
  registerTools,
  SeenSet,
  type Cursor,
  type Topic,
  type ToolDeps,
} from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { MatrixPlugin } from '../src/index.js';
import { A, HOMESERVER, isMatrixUp, SERVER_NAME } from './live-gate.js';

const up = await isMatrixUp();

type Answer = { content: Array<{ type: string; text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Answer>;

const toolOf = (deps: ToolDeps): Handler => {
  let h: Handler | undefined;
  const collector = {
    registerTool: (name: string, _c: unknown, fn: Handler) => {
      if (name === 'parley_fetch_recent') h = fn;
    },
  };
  registerTools(collector as unknown as Parameters<typeof registerTools>[0], deps);
  return h!;
};

const answerOf = (a: Answer) =>
  JSON.parse(a.content[0]!.text) as { messages: { content: string }[]; nextCursor?: string };

/** The procedure as `docs/CONVENTIONS.md` shipped it BEFORE this round: stop on an empty page. */
const stopsOnEmptyPage = async (fetch: Handler, topic: Topic): Promise<string[]> => {
  const got: string[] = [];
  let since: string | undefined;
  for (let page = 0; page < 200; page++) {
    const args: Record<string, unknown> = { topic: String(topic), limit: 1 };
    if (since !== undefined) args.since = since;
    const a = answerOf(await fetch(args));
    if (a.messages.length === 0) return got;
    got.push(...a.messages.map((m) => m.content));
    if (a.nextCursor === undefined || a.nextCursor === since) return got;
    since = a.nextCursor;
  }
  return got;
};

/** The procedure as it ships NOW: the terminal condition is the cursor standing still. */
const stopsWhenTheCursorDoes = async (fetch: Handler, topic: Topic): Promise<string[]> => {
  const got: string[] = [];
  let since: string | undefined;
  for (let page = 0; page < 200; page++) {
    const args: Record<string, unknown> = { topic: String(topic), limit: 1 };
    if (since !== undefined) args.since = since;
    const a = answerOf(await fetch(args));
    got.push(...a.messages.map((m) => m.content));
    if (a.nextCursor === undefined || a.nextCursor === since) return got;
    since = a.nextCursor;
  }
  return got;
};

/**
 * CLASS: the documented catch-up procedure's TERMINAL CONDITION, on the one shipped configuration
 * that produces the shape it has to survive. `shared_room` folds every topic into one Matrix room,
 * so a `/messages` page can hold nothing but other topics' events — and core filters a page to the
 * requested topic AFTER the plugin applied `limit`, which reaches the agent as an empty page whose
 * cursor moved on.
 *
 * Both procedures are run here, against the same room, in the same call sequence: the one that
 * stops on an empty page, and the one `docs/CONVENTIONS.md` and `TOOL_TEXT` ship — which stops only
 * when the cursor stands still. Measured on live Synapse (60 foreign events between two on-topic
 * ones, `limit: 1`): the first reaches 0 of the 3 messages the session missed and the second
 * reaches all 3. Keep BOTH, so that a doc rewritten back to "until a page comes back empty" has to
 * make this file green first.
 */
describe.skipIf(!up)('the catch-up loop ends on a cursor that stopped, not on an empty page', () => {
  it('the documented loop reaches all 3 the session missed; the empty-page stop reaches 0', async () => {
    const room = `parley_a1_proof_${Date.now().toString(36)}`;
    const config = {
      homeserver_url: HOMESERVER,
      server_name: SERVER_NAME,
      user: A.user,
      password: A.password,
      shared_room: room,
      sync_timeout_ms: 3000,
    };
    const plugin = new MatrixPlugin();
    await plugin.connect(config);
    const mine = asTopic(`mine-${Date.now().toString(36)}`);
    const other = asTopic(`other-${Date.now().toString(36)}`);
    const writer = asHandle('writer');
    try {
      const positions = new Map<Topic, Cursor>();
      const deps: ToolDeps = {
        plugin,
        identity: writer,
        allow: new Allowlist([String(mine)]),
        seen: new SeenSet(),
        readState: { get: (t) => positions.get(t), set: (t, c) => void positions.set(t, c) },
        blockMaxMs: 60_000,
        blockPollIntervalMs: 20,
      };
      const fetchRecent = toolOf(deps);

      await plugin.post(mine, writer, 'mine-0');
      expect(await stopsWhenTheCursorDoes(fetchRecent, mine)).toEqual(['mine-0']);

      // 60 foreign rows on another topic in the SAME room, then the three this session misses.
      for (let i = 0; i < 60; i++) await plugin.post(other, writer, `foreign-${i}`);
      const missed = ['mine-1', 'mine-2', 'mine-3'];
      for (const c of missed) await plugin.post(mine, writer, c);

      // The empty-page stop first, so the documented loop resumes from exactly where it left the
      // position — the same session, on the same server, continuing the same catch-up.
      const stopped = await stopsOnEmptyPage(fetchRecent, mine);
      const reached = await stopsWhenTheCursorDoes(fetchRecent, mine);

      expect(
        [...stopped, ...reached],
        'the documented catch-up loop did not reach what the session missed on a real homeserver',
      ).toEqual(missed);
      expect(
        stopped,
        'the empty-page stop reached something here, so this room no longer produces the shape ' +
          'the case exists for and the comparison below proves nothing',
      ).toEqual([]);
    } finally {
      await plugin.disconnect();
    }
  }, 120_000);
});
