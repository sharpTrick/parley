import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as allowlistMod from '../allowlist.js';
import {
  INITIALIZE,
  MCP_HEADERS,
  serveRemoteHttp,
  type ServedApp,
} from '../test-support/http-app.js';
import { parse } from '../test-support/tool-harness.js';

/**
 * One subject: what a client gets back from the reactive /mcp endpoint, and what each POST costs.
 * The endpoint is STATELESS — a fresh transport + server per request — so the round trip, the
 * per-request rebuild, and the absence of any session id are three readings of the same design.
 * Its refusals live in http-gating.test.ts and its start/stop in root-lifecycle.test.ts.
 */

let served: ServedApp;
let client: Client;

async function connectTo(port: number): Promise<Client> {
  const c = new Client({ name: 'chat-stand-in', version: '0.0.0' }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return c;
}

beforeEach(async () => {
  served = await serveRemoteHttp({ insecureNoAuth: true });
  client = await connectTo(served.port);
});

afterEach(async () => {
  await client.close();
  await served.teardown();
});

describe('remote HTTP transport (reactive, unauthenticated)', () => {
  it('connects over HTTP and lists the reactive tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'parley_fetch_recent',
      'parley_post',
      'parley_reply',
    ]);
  });

  it('post + fetch_recent round-trip over HTTP', async () => {
    await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'hello over http' } });
    const res = await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx' } });
    const out = parse(res) as { messages: Array<{ content: string }> };
    expect(out.messages.map((m) => m.content)).toEqual(['hello over http']);
  });

  /**
   * The remote root keeps NO read position, and that is a decision rather than an oversight. It is
   * stateless — a fresh server per POST, one shared `ToolDeps` for every client on the port — so a
   * single position here would be several chat sessions' at once: each would advance past what the
   * others had not been handed, and what one session read would go missing from another for good.
   * The local stdio bridge, which is one session by construction, is where the position lives.
   *
   * Graded through the endpoint rather than off the dependency bag, so wiring a store in — the one
   * change that would make this root worse — reddens here whatever shape it arrives in.
   */
  it('keeps no read position: a since-less read is the recent window, however many times it is made', async () => {
    for (let i = 0; i < 12; i++) {
      await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: `m${i}` } });
    }
    const windowOf = async (c: Client): Promise<string[]> =>
      (
        parse(
          await c.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx', limit: 4 } }),
        ) as { messages: Array<{ content: string }> }
      ).messages.map((m) => m.content);

    const newest = ['m8', 'm9', 'm10', 'm11'];
    expect(await windowOf(client)).toEqual(newest);
    // …the same client again, and a second client sharing the port: neither resumes past it.
    expect(await windowOf(client)).toEqual(newest);
    const second = await connectTo(served.port);
    try {
      expect(
        await windowOf(second),
        'the remote root advanced a read position. It is shared by every client on this port, so ' +
          "one chat session's reads now move another session's resume point past pages that " +
          'session was never handed',
      ).toEqual(newest);
    } finally {
      await second.close();
    }
  });

  /**
   * A CONTROL this door advertises must mean here what its description says. `from` is the worked
   * example: the schema accepted it, `TOOL_TEXT.fetch_recent_from` stated unconditionally that
   * "position" resumes from where this instance last read, and on a door with no read position
   * both values returned the same page. `TOOL_TEXT.fetch_recent` hedges that clause for exactly
   * this deployment; the argument did not.
   *
   * Graded per ARGUMENT rather than for `from` alone, and by DRIVING each one: an argument whose
   * value changes nothing here has to say so, or not be advertised. Comparing the two doors' tool
   * lists — which is all anything did — cannot see this, because the lists are identical.
   */
  describe('every advertised fetch_recent argument means what it says on THIS door', () => {
    /**
     * Two argument sets per row that a door HONOURING the argument must answer differently — in the
     * page it returns, or in how long it takes to return it, which is the only difference
     * `block_ms` makes.
     */
    const CONTRASTS: Record<
      string,
      (head: string) => [Record<string, unknown>, Record<string, unknown>]
    > = {
      since: () => [{}, { since: '3' }],
      limit: () => [{ limit: 2 }, { limit: 4 }],
      from: () => [{ from: 'position' }, { from: 'recent' }],
      block_ms: (head) => [
        { since: head, block_ms: 0 },
        { since: head, block_ms: 400 },
      ],
    };
    const PARKED_MS = 150;

    const advertised = async (): Promise<Record<string, { description?: string }>> => {
      const { tools } = await client.listTools();
      const fetchRecent = tools.find((t) => t.name === 'parley_fetch_recent')!;
      const properties = (fetchRecent.inputSchema as { properties?: Record<string, { description?: string }> })
        .properties;
      return properties ?? {};
    };

    it('covers every optional argument the door advertises', async () => {
      const optional = Object.keys(await advertised()).filter((name) => name !== 'topic');
      expect(
        optional.filter((name) => !(name in CONTRASTS)),
        'an argument reached the advertised schema with no row here, so nothing asks whether it ' +
          'means anything on a door that keeps no read position',
      ).toEqual([]);
      expect(optional.length).toBeGreaterThan(2);
    });

    it.each(Object.keys(CONTRASTS))('%s', async (name) => {
      for (let i = 0; i < 12; i++) {
        await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: `n${i}` } });
      }
      /** What the caller can observe: the page, and whether the call parked. */
      const answer = async (extra: Record<string, unknown>): Promise<string> => {
        const started = Date.now();
        const out = parse(
          await client.callTool({
            name: 'parley_fetch_recent',
            arguments: { topic: 'ctx', limit: 4, ...extra },
          }),
        ) as { messages: Array<{ content: string }>; nextCursor?: string };
        return JSON.stringify([
          out.messages.map((m) => m.content),
          Date.now() - started > PARKED_MS,
        ]);
      };
      const head = (
        parse(
          await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx', limit: 1 } }),
        ) as { nextCursor?: string }
      ).nextCursor!;

      const [a, b] = CONTRASTS[name]!(head);
      const honoured = (await answer(a)) !== (await answer(b));
      if (honoured) return;

      const description = (await advertised())[name]?.description ?? '';
      expect(
        description,
        `${name} changes nothing on this door, and its description does not say so. A control the ` +
          'schema ACCEPTS and the deployment IGNORES is worse than one it refuses: the model is ' +
          'told it steered something',
      ).toContain('THIS bridge keeps no read position');
    });
  });

  it('is reactive-only — does NOT advertise the claude/channel capability', () => {
    const caps = client.getServerCapabilities();
    expect(caps?.experimental?.['claude/channel']).toBeUndefined();
    expect(caps?.tools).toBeDefined();
  });

  it('rejects a topic outside the allowlist (isError, not a crash)', async () => {
    const res = (await client.callTool({
      name: 'parley_post',
      arguments: { topic: 'secret', content: 'x' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    // Closed allowlist → `topic` is a z.enum, so the SDK rejects a disallowed topic at the schema
    // layer (Invalid enum value); with a post pattern it would be allow.assert's "topic not
    // allowed". Either way it is an isError result, not a crash.
    expect(res.content[0]!.text).toMatch(/invalid enum value|topic not allowed/i);
  });
});

/**
 * What app scope actually amortizes, MEASURED on both sides. A stateless transport splits its work
 * in two — derived once when the app is built, and rebuilt for every POST — and a claim about which
 * side a given piece falls on is worth exactly what the count that pins it is worth: an operator
 * profiling a slow /mcp endpoint under a large `topics` + `post_topics` config is steered by it.
 * So take a reading on each side: a total for what is shared, and a per-request DELTA for what is
 * not, so that a piece silently moving between them fails here instead of being described wrongly.
 */
describe('reactive HTTP: what app scope amortizes, and what it does not', () => {
  it('compiles the allowlist once for the app, and rebuilds the tool descriptions per POST', async () => {
    const spy = vi.spyOn(allowlistMod, 'allowlistFor');
    const readers = new Set<unknown>();
    const realTopics = allowlistMod.Allowlist.prototype.topics;
    // `allow.topics()` is what `describeAllowed`/`topicList`/`topicSchema` walk to build each tool's
    // description and enum, so its call count is the tool-description build count.
    const described = vi
      .spyOn(allowlistMod.Allowlist.prototype, 'topics')
      .mockImplementation(function (this: allowlistMod.Allowlist): ReturnType<typeof realTopics> {
        readers.add(this);
        return realTopics.call(this);
      });
    const { port, teardown } = await serveRemoteHttp({ insecureNoAuth: true });
    const c = await connectTo(port);
    try {
      // Several POSTs, each building a brand-new reactive server + transport. `parley_post`'s
      // handler never reads the topic list itself, so every call counted is a description rebuild.
      described.mockClear();
      await c.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'a' } });
      const perPost = described.mock.calls.length;
      await c.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'b' } });
      await c.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'c' } });

      // The descriptions are NOT amortized: they cost the same again on every POST.
      expect(perPost).toBeGreaterThan(0);
      expect(described.mock.calls.length).toBe(3 * perPost);
      // The allowlist (and its regex compilation) IS: built exactly once, at app scope …
      expect(spy).toHaveBeenCalledTimes(1);
      expect(readers.size).toBe(1); // … and every request read that same instance.
    } finally {
      await c.close();
      await teardown();
      described.mockRestore();
      spy.mockRestore();
    }
  });
});

/**
 * The public JSDoc once described the opposite design (session-per-connection, reused by
 * `mcp-session-id`). Pin the observable session contract instead of the sentence, so a doc that
 * regrows session affinity is contradicted by a failing test rather than by a neighbouring comment.
 */
describe('reactive HTTP is stateless: no session id, no GET/DELETE', () => {
  it('the initialize response carries no mcp-session-id header', async () => {
    const { port, teardown } = await serveRemoteHttp({ insecureNoAuth: true });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: INITIALIZE,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).toBeNull();
    } finally {
      await teardown();
    }
  });

  // Keep GET/DELETE's 405 in the METHOD × auth grid in http-gating.test.ts rather than here, so that
  // a case asserting it cannot pass on a route that has silently lost its auth middleware.
});
